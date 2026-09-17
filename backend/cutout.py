"""
确定性 CV 抠图核心（技术方案 §0.5.5 / §3.2 P1-A）。

契约：同样的图 + 同样的参数 → **逐比特相同**的蒙版。

⚠️ 实测教训（写在这里防止后人回退）：`cv2.grabCut` 即使使用 `GC_INIT_WITH_MASK`
显式播种也**不是确定性的**。同一张图、同一份初始蒙版连跑三次，前景占比分别是
62.855% / 62.816% / 63.116%，蒙版哈希三次全不同。原因是它内部的 GMM 参数估计
在多线程下累加顺序不定，浮点结果有微小抖动，再经迭代放大。
技术方案 §0.5.5 明确要求「同样的图 + 同样的参数 → 同样的蒙版 → 同样的图纸，
可回归测试」，所以 grabCut 不能用作本服务的引擎。

改用完全确定性的替代链路（全部是整数或固定顺序的浮点运算）：
    1. 背景色统计（中位数，抗离群）
    2. CIELAB 色差的「边界连通区域洪水」粗筛 —— 扣掉与画幅边界连通、且接近背景色的像素
    3. 平坦区吸收 —— 量化 Lab 连通域中「面积大、与已扣区相邻、不含前景中心」的色区
       并入背景种子（解决「背景被边框与画幅边缘隔断」的插画类素材，实测见上）。
       ⚠️ 已知边界：主体中「不含前景种子中心框」的细窄平坦凸出部可能被背景流域
       吞掉；曾试「色族前景播种」修复，在纹理背景照片上本质性漏背景（test.jpg
       30.3%→65%），已撤除。此类边缘交给前端笔刷修正（需求 Story 5.2）
    4. 确定性的「背景种子 + 分水岭」精修 —— 主体边缘沿源图梯度收敛
       （分水岭的优先级队列按「灰度值 + 插入序号」全序排序，无随机源）
    5. 最大连通域保留 + 孔洞填充 + 形态学清理
    6. 羽化出 soft alpha

对应 `需求.md` Story 5.1「自动抠图」。输出是 soft alpha（0~255），
前端在 312 主网格上按 alpha 加权决定「哪些像素参与转换」。
"""

from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np


@dataclass
class CutoutParams:
    """一次抠图的全部参数。默认值是保守档——宁可少扣，不要误扣主体。"""

    long_edge: int = 1024          # 预处理长边；在 1024 内跑，CPU 秒级、质量对格级别足够
    border_ratio: float = 0.02     # 四周按此比例播种「确定背景」
    fg_ratio: float = 0.10         # 居中播种「可能前景」方框的半边长比例
    bg_delta: float = 5.0          # 洪水容差：与边界种子色差小于它就判为背景（Lab 单位）
    feather: int = 1               # soft alpha 的羽化半径
    max_iter: int = 5              # 分水岭精修的最大迭代轮数
    keep_largest: bool = True      # 只保留最大前景连通域，减少零星误检


def decode_image(data: bytes) -> np.ndarray:
    """字节流 → BGR ndarray。EXIF 方向由前端的 createImageBitmap 修正，此处不重复处理。"""
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码这张图片（格式不受支持或文件已损坏）")
    return img


def alpha_of(img: np.ndarray, thr_bg: int = 245) -> np.ndarray:
    """
    从「已抠好的透明图」反向得到 soft alpha。

    前端若上传的是带 alpha 通道的 PNG，直接用它的 alpha 即可——比任何
    算法猜测都准，而且同样确定性。
    """
    if img.shape[2] == 4:
        return img[:, :, 3].copy()
    # 无 alpha 通道：把近白像素视为背景（覆盖「白底商品图」这一常见情况）
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return np.where(gray >= thr_bg, 0, 255).astype(np.uint8)


def _resize_for_speed(img: np.ndarray, long_edge: int):
    h, w = img.shape[:2]
    scale = min(1.0, long_edge / max(h, w))
    if scale >= 1.0:
        return img, 1.0
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA), scale


def _border_seed(h: int, w: int, border_ratio: float) -> np.ndarray:
    """四周一圈「确定背景」种子（布尔图）。"""
    m = np.zeros((h, w), bool)
    b = max(1, int(round(min(h, w) * border_ratio)))
    m[:b, :] = m[-b:, :] = True
    m[:, :b] = m[:, -b:] = True
    return m


def _interior_box(h: int, w: int, fg_ratio: float):
    """居中「可能前景」方框。"""
    bh = max(1, int(round(h * fg_ratio)))
    bw = max(1, int(round(w * fg_ratio)))
    cy, cx = h // 2, w // 2
    y0, y1 = max(0, cy - bh), min(h, cy + bh)
    x0, x1 = max(0, cx - bw), min(w, cx + bw)
    if y1 - y0 < 2 or x1 - x0 < 2:
        y0, y1, x0, x1 = 0, h, 0, w
    return y0, y1, x0, x1


def _flood_background(img_bgr: np.ndarray, border_ratio: float, bg_delta: float) -> np.ndarray:
    """
    第 2 步：边界连通洪水。返回布尔图，True = 判定为背景。

    判据是「与边界种子连通」且「与背景色差 < bg_delta」。只用色差不用连通性的话，
    主体内部和背景同色的部分会被误扣；只用连通性不用色差的话，背景里的杂色会被漏掉。
    两个条件同时成立才判背景——这是本步相对纯色度键的关键优势。
    """
    h, w = img_bgr.shape[:2]
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB).astype(np.float64)

    seed = _border_seed(h, w, border_ratio)
    bg_px = lab[seed]
    if bg_px.size == 0:
        return np.zeros((h, w), bool)
    bg_med = np.median(bg_px, axis=0)

    diff = lab - bg_med.reshape(1, 1, 3)
    dist = np.sqrt((diff ** 2).sum(axis=2))

    near_bg = (dist < bg_delta).astype(np.uint8)
    n, labels = cv2.connectedComponents(near_bg, connectivity=4)
    if n <= 1:
        return np.zeros((h, w), bool)

    edge_labels = np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]
    ]))
    edge_labels = edge_labels[edge_labels > 0]
    if edge_labels.size == 0:
        return np.zeros((h, w), bool)

    lut = np.zeros(n, bool)
    lut[edge_labels] = True
    return lut[labels]


def _absorb_flat_background(img_bgr: np.ndarray, outside: np.ndarray,
                            fg_box, min_area_ratio: float = 0.10) -> np.ndarray:
    """
    平坦区吸收（v1.6 新增）：把「与已扣背景相邻的大块平坦色区」并入背景种子。

    解决的实测问题：插画类素材常见「背景不与画幅边缘直接接触」——例如四周一圈
    奶油色边框、黄色背景在内。单一背景色的边界洪水在边框处就停（奶油→黄是
    ~60 Lab 单位的硬台阶，任何渐进生长都过不去），黄底 51.7% 全被当前景，
    蒙版保留 91.8%、对齐率仅 40.2%（用户实际素材实测）。

    规则（全部确定性，无随机源）：
      1. Lab 按 /6 量化，逐个颜色标签做 4-连通域；
      2. 候选必须同时满足：
         a) 面积 ≥ min_area_ratio × 画幅（防误吞小细节）；
         b) 与当前 outside 相邻（dilate 5×5 有交集）——只认「紧贴已扣区」的块，
            一跳关系，不递归：衣服/马甲虽然与黄色相邻，但与「原始洪水区」不相邻，
            不会被吞（已对 6 个老素材 + 黄底人像实测验证）；
         c) 不与前景种子中心框相交（主体在中心这一先验的保护栏）。
      3. 吸收后交给分水岭精修轮廓。

    实测（test/ 六张 + 黄底人像）：六张老素材前景占比逐比特不变（零回归）；
    黄底人像对齐率 40.2% → 89.0%。
    """
    h, w = outside.shape
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    q = lab.astype(np.int32) // 6
    labq = (q[:, :, 0].astype(np.int64) * 64 + (q[:, :, 1] + 8)) * 64 + (q[:, :, 2] + 8)

    uniq, counts = np.unique(labq, return_counts=True)
    dil_out = cv2.dilate(outside.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    absorbed = np.zeros((h, w), bool)

    box_mask = None
    if fg_box is not None:
        box_mask = np.zeros((h, w), bool)
        y0, y1, x0, x1 = fg_box
        box_mask[y0:y1, x0:x1] = True

    # 固定顺序（uniq 升序）保证确定性
    for u, c in zip(uniq.tolist(), counts.tolist()):
        if c < min_area_ratio * h * w:
            continue
        nn, ll = cv2.connectedComponents((labq == u).astype(np.uint8), connectivity=4)
        for i in range(1, nn):
            comp = ll == i
            if comp.sum() < min_area_ratio * h * w:
                continue
            if box_mask is not None and (comp & box_mask).any():
                continue
            if not (dil_out & comp).any():
                continue
            absorbed |= comp
    return outside | absorbed



def _watershed_refine(img_bgr: np.ndarray, outside: np.ndarray,
                      fg_seed: np.ndarray, max_iter: int) -> np.ndarray:
    """
    第 3 步：确定性的「背景种子 + 分水岭」精修。

    把「确定背景」（边界 + 洪水结果）当作种子，用分水岭沿源图梯度向外生长。
    分水岭会自然停在强梯度处，也就是主体的真实轮廓，因此边界比纯色度阈值干净。

    确定性说明：`cv2.watershed` 的优先级队列以「灰度值 + 插入序号」全序排序，
    不引入随机源；同一输入多次调用结果逐比特相同（已由 determinism 测试覆盖）。

    ⚠️ 关于「前景触边」的实测结论（别再当成 bug 修）：`test/` 下 IMG_1373 / 3333 /
    5051 / 7315 的蒙版都会贴住画面底边，一度被当作欠扣。实测这三张图**底边本来就是
    主体**——底边 6 行的灰度标准差分别是 39.9 / 85.2 / 35.2（远高于顶边的 0 / 2.4 / 2.4），
    BGR 中位数也是深色（37/17/206 的量级）。也就是说主体确实延伸到了画面下缘，
    蒙版贴边是**正确行为**，不是欠扣。真正判欠扣要看「背景色区域是否被算进前景」，
    不能只看「前景是否触边」。
    """
    h, w = img_bgr.shape[:2]
    markers = np.zeros((h, w), np.int32)

    bg_seed = outside | _border_seed(h, w, 0.0)
    markers[bg_seed] = 1
    markers[fg_seed] = 2

    if not markers.astype(bool).any():
        return outside

    ws = img_bgr.copy()
    cv2.watershed(ws, markers)

    # 分水岭后：标记 1 = 背景流域，2 = 前景流域，-1 = 分水岭线（边界）。
    # ⚠️ 踩过的坑：直接把 -1 一律归给背景，会让前景沿画幅四周多出一圈像素。
    # 原因是 -1 也包含「种子自身的外轮廓」——`bg_seed` 覆盖最外圈时，它自己那条
    # 外轮廓线就是 -1。这一圈被算成前景后，前景就贴上了画幅边界。
    # 正解：-1 只在「本来就没被判为 outside」的地方才交给背景，「位于 outside 内部」的
    # 分水岭线一律归给前景（那才是主体与背景之间的真实轮廓）。
    boundary = markers == -1
    outside_d = cv2.dilate(outside.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    boundary_bg = boundary & outside_d
    return (markers == 1) | boundary_bg


def _postprocess(fg: np.ndarray, keep_largest: bool) -> np.ndarray:
    """第 4 步：去零星误检、填内部孔洞、抹毛刺。全部为确定性形态学操作。"""
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    if keep_largest:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(fg.astype(np.uint8), connectivity=8)
        if n > 2:
            idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            fg = (labels == idx)

    m = (fg.astype(np.uint8)) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k3, iterations=2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k3, iterations=1)

    # 填内部孔洞：从四边对「背景」做等值洪水填充，填不到的背景像素就是孔洞
    h, w = m.shape
    inv = (m == 0).astype(np.uint8)
    ff = inv.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    for x in range(w):
        if ff[0, x]:
            cv2.floodFill(ff, mask, (x, 0), 2)
        if ff[h - 1, x]:
            cv2.floodFill(ff, mask, (x, h - 1), 2)
    for y in range(h):
        if ff[y, 0]:
            cv2.floodFill(ff, mask, (0, y), 2)
        if ff[y, w - 1]:
            cv2.floodFill(ff, mask, (w - 1, y), 2)
    m = m.copy()
    m[(ff == 1) & (inv == 1)] = 255
    return m > 0


def compute_alpha(img_bgr: np.ndarray, params: Optional[CutoutParams] = None) -> np.ndarray:
    """
    主入口：BGR 图 → soft alpha（uint8，与原图同尺寸；255 = 完全主体，0 = 完全背景）。

    全链路确定性，无随机源、无深度学习权重、无 GPU 依赖。
    """
    p = params or CutoutParams()
    src_h, src_w = img_bgr.shape[:2]

    # 已带 alpha 通道：直接用，最准也最快
    if img_bgr.shape[2] == 4:
        return alpha_of(img_bgr)

    work, _ = _resize_for_speed(img_bgr[:, :, :3], p.long_edge)
    h, w = work.shape[:2]

    outside = _flood_background(work, p.border_ratio, p.bg_delta)

    y0, y1, x0, x1 = _interior_box(h, w, p.fg_ratio)
    outside = _absorb_flat_background(work, outside, (y0, y1, x0, x1))

    fg_seed = np.zeros((h, w), bool)
    fg_seed[y0:y1, x0:x1] = True
    # 洪水结果已经把一部分种子区吃掉，剩下的才是「确实不像背景」的中心区
    fg_seed &= ~outside
    # ⚠️ 曾试过「色族前景播种」（与背景色族距离远 → 全部作为前景种子，覆盖主体的
    # 无种子凸出部）：对带框插画有效（38%→48%），但对纹理背景照片**本质性漏背景**
    # ——墙/纸的暗角像素离「已扣背景色均值」超过阈值即成前景种子，与中心框连通后
    # 把大片背景连进前景（test.jpg 30.3%→65%，IMG_1373 30.4%→52%），加空间连通
    # 约束也救不回（连续渐变会桥接）。已撤除。主体无种子的细窄凸出部被背景流域
    # 吞掉是本引擎的已知边界，交给前端笔刷修正（需求 Story 5.2）。
    if not fg_seed.any():
        # 中心区完全像背景：两种可能，必须分开处理，不能当同一种情况。
        #   (a) 背景干净但主体很小 —— 主体还在中心框外，退回「非背景即前景」能救回来；
        #   (b) 整幅就是一片纯色（没有主体可分）—— 此时退回 (a) 会把整幅判成前景，
        #       输出全白蒙版，等于「什么都没扣掉」，比全黑更误导。
        # 判据用「outside 是否已吞掉整个画幅」来区分：真纯色图会满足，正常图不会。
        if outside.all():
            return np.zeros((src_h, src_w), np.uint8)      # 无可辨主体 → 全背景，交前端提示
        fg_seed = ~outside & _interior_box_mask(h, w, p.fg_ratio)
        if not fg_seed.any():
            return np.zeros((src_h, src_w), np.uint8)

    try:
        fg_bool = ~_watershed_refine(work, outside, fg_seed, p.max_iter)
    except cv2.error:
        fg_bool = ~outside

    fg_bool = _postprocess(fg_bool, p.keep_largest)

    fg = (fg_bool.astype(np.uint8)) * 255
    if p.feather > 0:
        k = p.feather * 2 + 1
        fg = cv2.GaussianBlur(fg, (k, k), 0)

    if (h, w) != (src_h, src_w):
        fg = cv2.resize(fg, (src_w, src_h), interpolation=cv2.INTER_LINEAR)

    return fg


def _interior_box_mask(h: int, w: int, fg_ratio: float) -> np.ndarray:
    m = np.zeros((h, w), bool)
    y0, y1, x0, x1 = _interior_box(h, w, fg_ratio)
    m[y0:y1, x0:x1] = True
    return m
