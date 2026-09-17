"""
后端抠图回归测试。

最要紧的一条是 `test_determinism`：技术方案 §0.5.5 把「同样的图 + 同样的参数 →
同样的蒙版」列为选用确定性 CV 而非生成式模型的**首要理由**，也正是回归基线的
前提。这条测试是它的护栏。

跑法：
    cd backend && python3 test_cutout.py
"""

import hashlib
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cutout import CutoutParams, alpha_of, compute_alpha, decode_image  # noqa: E402

TEST_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test")


def _sha(a: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()


def _sample_images():
    out = []
    if not os.path.isdir(TEST_DIR):
        return out
    for name in sorted(os.listdir(TEST_DIR)):
        if name.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp")):
            out.append(os.path.join(TEST_DIR, name))
    return out


class TestDeterminism(unittest.TestCase):
    """同一输入必须逐比特复现 —— 这是整个确定性契约的护栏。"""

    def test_determinism(self):
        files = _sample_images()
        if not files:
            self.skipTest("test/ 目录下没有可用素材")
        for f in files:
            with self.subTest(img=os.path.basename(f)):
                img = decode_image(open(f, "rb").read())
                hs = {_sha(compute_alpha(img)) for _ in range(3)}
                self.assertEqual(len(hs), 1, f"{os.path.basename(f)} 三次抠图结果不一致")

    def test_determinism_across_redecode(self):
        """重新解码同一份字节流也必须得到同一蒙版（防止引入解码期随机源）。"""
        files = _sample_images()
        if not files:
            self.skipTest("test/ 目录下没有可用素材")
        f = files[0]
        data = open(f, "rb").read()
        a = _sha(compute_alpha(decode_image(data)))
        b = _sha(compute_alpha(decode_image(data)))
        self.assertEqual(a, b)


class TestAlphaSynthesised(unittest.TestCase):
    """合成图案，用来钉死「不该发生的」行为（对应 §0.4 白变黑事故的同类探针）。"""

    def _canvas(self, h=240, w=240, bg=(255, 255, 255)):
        img = np.zeros((h, w, 3), np.uint8)
        img[:, :] = bg
        return img

    def test_white_background_dark_subject(self):
        """白底深色方块：背景必须被扣掉，主体必须保留，且不出现「整幅纯黑/纯白」。"""
        img = self._canvas()
        img[70:170, 80:160] = (40, 40, 200)          # BGR，红块
        a = compute_alpha(img)
        self.assertEqual(a.shape, (240, 240))
        self.assertGreater(a[120, 120], 200, "主体中心被判成背景")
        self.assertLess(a[5, 5], 60, "角落背景未被扣除")
        ratio = (a >= 128).mean()
        self.assertGreater(ratio, 0.03, "前景被整体抠没了")
        self.assertLess(ratio, 0.75, "背景没被扣掉多少")

    def test_uniform_image_does_not_crash(self):
        """整幅同色（无主体可分）：不许抛异常，且必须返回有限值。"""
        img = self._canvas(bg=(128, 128, 128))
        a = compute_alpha(img)
        self.assertEqual(a.shape, (240, 240))
        self.assertTrue(np.isfinite(a).all())

    def test_black_white_probe(self):
        """
        §0.4 白变黑事故的同类回归探针：纯白/纯黑输入不许出现 NaN→0 的静默退化。

        对「整幅单色」这张图，正确行为是**判无可辨主体、返回全 0（一个豆子都不留）**：
        整幅都是背景色，本来就无主体可分。若这里返回全 255，反而意味着「什么都
        没扣掉」，那才是真故障。所以本测试钉的是「必须是可解释的 {0} 或 {255}，
        且不许是 NaN/未定义」，而不是「必须有前景」。
        """
        for bg in ((255, 255, 255), (0, 0, 0), (128, 128, 128)):
            with self.subTest(bg=bg):
                a = compute_alpha(self._canvas(bg=bg))
                self.assertTrue(np.isfinite(a).all(), "出现 NaN/Inf")
                uniq = set(np.unique(a).tolist())
                self.assertTrue(uniq.issubset({0, 255}), f"单色图不该产生过渡灰：{uniq}")
                self.assertEqual(uniq, {0},
                                 "整幅单色时应当判为无可辨主体（全背景），而不是把整幅当主体")

    def test_no_subject_is_flagged_not_silently_white(self):
        """「无可辨主体」必须能被前端识别出来——返回全 0 而不是全 255。"""
        a = compute_alpha(self._canvas(bg=(255, 255, 255)))
        self.assertEqual(int((a >= 128).sum()), 0,
                         "纯色图若返回全前景，等于抠图静默失效，前端会以为抠成功了")


class TestFramedFlatBackground(unittest.TestCase):
    """
    「背景被边框与画幅边缘隔断」的插画类素材（v1.6 平坦区吸收的回归护栏）。

    实测背景：用户素材是一张四周带奶油色边框、黄色背景的人像插画——
    黄底占 51.7% 却与画幅边缘接触为 0%，单一背景色的边界洪水在边框处停止，
    旧引擎蒙版保留 91.8%、对齐率 40.2%（等于没抠）。
    本测试用合成图复现该结构：奶油外框 + 黄色底 + 中央深色主体。
    """

    @staticmethod
    def _framed_image(w=480, h=360):
        img = np.full((h, w, 3), 236, np.uint8)          # 奶油外框（不接触黄）
        img[24:-24, 24:-24] = (60, 200, 240)              # 黄色背景（BGR）
        img[h//2-60:h//2+60, w//2-70:w//2+70] = (30, 30, 40)  # 深色主体
        return img

    # ⚠️ 引擎边界（记录，勿再试启发式）：主体「不含前景种子中心框」的细窄凸出部
    # （穿过背景伸到边框的窄条带）会被四周背景流域吞掉。曾试「色族前景播种」来救，
    # 实测在纹理背景照片上把大片背景漏进前景（test.jpg 30.3%→65%、IMG_1373
    # 30.4%→52%），已撤除。此类边缘交前端笔刷修正（需求 Story 5.2）。
    # 下方测试只覆盖平坦区吸收这一项确定性改进。

    def test_flat_field_inside_frame_is_removed(self):
        a = compute_alpha(self._framed_image(), CutoutParams(feather=0))
        fg = a >= 128
        h, w = fg.shape
        # 黄色区域不应在前景里（面积上的硬断言：黄占 82%，前景只能 ≈ 主体）
        self.assertLess(fg.mean(), 0.30,
            "黄底没有被扣除——平坦区吸收未生效（保留 %.0f%%）" % (100 * fg.mean()))
        self.assertGreater(fg.mean(), 0.05, "前景被整体抠没了")
        # 主体中心必须保留
        self.assertGreater(a[h // 2, w // 2], 200)
        # 四角（奶油框）必须扣除
        for y, x in ((2, 2), (2, w - 3), (h - 3, 2), (h - 3, w - 3)):
            self.assertLess(a[y, x], 60, "奶油边框未被扣除 (%d,%d)" % (y, x))

class TestAlphaChannelPassthrough(unittest.TestCase):
    """已带 alpha 通道的 PNG 直接用它的 alpha —— 比任何算法猜测都准。"""

    def test_uses_existing_alpha(self):
        img = np.zeros((50, 50, 4), np.uint8)
        img[10:40, 10:40] = (0, 0, 0, 255)
        a = compute_alpha(img)
        np.testing.assert_array_equal(a, img[:, :, 3])

    def test_alpha_of_helper_falls_back_to_near_white(self):
        img = np.full((20, 20, 3), 255, np.uint8)
        img[5:15, 5:15] = 0
        a = alpha_of(img)
        self.assertEqual(a[10, 10], 255)
        self.assertEqual(a[0, 0], 0)


class TestParamsBounds(unittest.TestCase):
    def test_feather_zero_is_sharp(self):
        img = np.full((120, 120, 3), 255, np.uint8)
        img[30:90, 30:90] = 0
        sharp = compute_alpha(img, CutoutParams(feather=0))
        self.assertTrue(set(np.unique(sharp)).issubset({0, 255}), "feather=0 时不该出现中间灰")

    def test_feather_adds_transition(self):
        img = np.full((120, 120, 3), 255, np.uint8)
        img[30:90, 30:90] = 0
        soft = compute_alpha(img, CutoutParams(feather=3))
        mid = ((soft > 10) & (soft < 245)).sum()
        self.assertGreater(mid, 0, "feather>0 时应有过渡带")

    def test_long_edge_downscales(self):
        img = np.full((800, 800, 3), 255, np.uint8)
        img[200:600, 200:600] = 0
        a = compute_alpha(img, CutoutParams(long_edge=256))
        self.assertEqual(a.shape, (800, 800), "输出必须缩回原尺寸")


if __name__ == "__main__":
    unittest.main(verbosity=2)
