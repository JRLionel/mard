"use strict";



/* ============================================================
   4. 流水线编排
   ============================================================ */
const $ = function (id) { return document.getElementById(id); };
const cv = $("cv"), ctx = cv.getContext("2d");
let imageData = null, imageName = "", imageWH = [0, 0], imageURL = "";
let master = null, masterOk = null, masterW = null;   // 312 主网格：sRGB / OKLab / 主体占比
let lastResult = null;
let running = false, pending = false, everRan = false, hintedMobile = false, showVeil = true;
let runToken = 0;                  // 重算代次：旧代次的结果一律丢弃，杜绝旧图覆盖新图
const NARROW = "(max-width: 960px)";

/* ---------- 4.0 精修状态 ----------
   三样东西各自独立，互不覆盖（这是需求里三条「不冲突」裁定的落地）：
     crop     {x,y,w,h} 裁剪框（原图像素坐标）；null = 用整幅。非破坏性，只影响参与转换的像素
     mask     Uint8Array 目标网格粒度的蒙版（0 = 空 / 1 = 主体）。粒度=预览档，笔刷在它上面涂
     edge     包边色（EMPTY = 关闭）。是独立图层，不改 cells
     manual   逐格手动改色覆盖层（Int16Array，EMPTY = 未改过）。改色优先于自动结果与包边，
              因此重算自动结果不会抹掉用户的修改；「重置」只清这一层
   历史栈存的是这些层的快照，而不是整份 cells —— 因为 cells 是可重算的派生数据，
   存它会让「撤销」在参数变化后变得不可解释。 */
const refine = {
  crop: null,
  cropPendingCrop: null,           // 裁剪框编辑中的临时状态（未确认前不生效）
  mask: null,                      // Uint8Array(MASK_N²)，锚定 _maskRect（工作区坐标）
  _maskRect: null,                 // 蒙版所属的工作区（裁剪变化时按重叠重映射）
  edge: EMPTY,
  manual: null,                    // Int16Array(target²)
  sel: null,                       // Uint8Array(target²) 选中态
  mode: "none"                   // none | crop | matt | edge | edit
};

/* 主网格分析的缓存签名。
   声明位置必须在这之前（放在 run() 定义之后会命中 let 的暂时性死区）——
   曾因为把这两行放在文件下方，导致 run() 里对它赋值时静默失效、
   主网格永远不重算，整条算法改动看起来「完全不生效」。 */
let masterSig = "", lastPoolLen = 0, lastConsist = null;

/* 4.1 手动覆盖层与蒙版的存取：统一在「预览档位 target」上操作 */
function ensureManual(target) {
  const n = target * target;
  if (!refine.manual || refine.manual.length !== n) {
    const old = refine.manual, oldT = refine._manualT || 0;
    refine.manual = new Int16Array(n).fill(EMPTY);
    // 档位变化时把旧覆盖层按区间映射过来：两档都是 312 的整数分块，
    // 映射是精确的整数包含关系（老格的 312 区段若与新格有交集就继承），无插值
    if (old && oldT && oldT !== target) {
      const step = MASTER / target;
      for (let i = 0; i < n; i++) {
        const ty = (i / target) | 0, tx = i - ty * target;
        const y0 = Math.round(ty * step), y1 = Math.round((ty + 1) * step);
        const x0 = Math.round(tx * step), x1 = Math.round((tx + 1) * step);
        for (let y = y0; y < y1; y++) {
          const oy = Math.round(y * oldT / MASTER);
          if (oy < 0 || oy >= oldT) continue;
          for (let x = x0; x < x1; x++) {
            const ox = Math.round(x * oldT / MASTER);
            if (ox < 0 || ox >= oldT) continue;
            const v = old[oy * oldT + ox];
            if (v !== EMPTY) refine.manual[i] = v;    // 重叠区域保留，超出部分自然丢弃
          }
        }
      }
    }
    refine._manualT = target;
  }
  return refine.manual;
}
function ensureSel(target) {
  const n = target * target;
  if (!refine.sel || refine.sel.length !== n) refine.sel = new Uint8Array(n);
  return refine.sel;
}
/* 蒙版锚定：固定分辨率 MASK_N(=312)、锚定在 workRect 上。
   旧实现把蒙版锚在「预览档位」上（_maskT 随 52/78/104 变），档位一换就重采样、
   裁剪一换就整体错位。现在与档位彻底解耦：消费方一律用「工作区归一化坐标」采样，
   裁剪确认时用 remapMaskToRect 按重叠区域重映射 —— 「先抠图后裁剪」与
   「先裁剪后抠图」都成立（需求矛盾表第 8 条）。 */
const MASK_N = MASTER;             // 312 是 52/78/104 的最小公倍数，目标格→蒙版格恒为整数倍
function setMask(arr, rect) {
  refine.mask = arr;
  refine._maskRect = rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null;
}
function clearMask() { refine.mask = null; refine._maskRect = null; }
/* 目标格是否属于主体（按工作区归一化中心采样蒙版） */
function maskCellKept(i, target) {
  if (!refine.mask) return true;
  const ty = (i / target) | 0, tx = i - ty * target;
  const mx = Math.min(MASK_N - 1, (((tx + 0.5) / target) * MASK_N) | 0);
  const my = Math.min(MASK_N - 1, (((ty + 0.5) / target) * MASK_N) | 0);
  return refine.mask[my * MASK_N + mx] ? true : false;
}
/* 把某目标格覆盖的蒙版像素整体置 v（补豆时把蒙版一并补回，置空时无需动蒙版） */
function maskCellSet(i, target, v) {
  if (!refine.mask) return;
  const ty = (i / target) | 0, tx = i - ty * target;
  const k = MASK_N / target;
  const y0 = Math.round(ty * k), y1 = Math.round((ty + 1) * k);
  const x0 = Math.round(tx * k), x1 = Math.round((tx + 1) * k);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) refine.mask[y * MASK_N + x] = v;
}
function maskKeptCount() {
  if (!refine.mask) return 0;
  let k = 0;
  for (let i = 0; i < refine.mask.length; i++) if (refine.mask[i]) k++;
  return k;
}
/* 裁剪确认后：蒙版从旧工作区重映射到新工作区（重叠保留、超出丢弃）。
   新蒙版每格（新工作区归一化）→ 原图像素 → 旧工作区归一化 → 采样旧蒙版；
   落在旧工作区外的点判 0 —— 旧区外本来就不参与转换。 */
function remapMaskToRect(oldRect, newRect) {
  if (!refine.mask) return;
  const old = refine.mask, N = MASK_N;
  const out = new Uint8Array(N * N);
  for (let my = 0; my < N; my++) {
    const py = newRect.y + (my + 0.5) / N * newRect.h;
    const oyN = (py - oldRect.y) / oldRect.h;
    if (oyN < 0 || oyN >= 1) continue;
    const oy = Math.min(N - 1, (oyN * N) | 0);
    for (let mx = 0; mx < N; mx++) {
      const px = newRect.x + (mx + 0.5) / N * newRect.w;
      const oxN = (px - oldRect.x) / oldRect.w;
      if (oxN < 0 || oxN >= 1) continue;
      out[my * N + mx] = old[oy * N + Math.min(N - 1, (oxN * N) | 0)];
    }
  }
  refine.mask = out;
  refine._maskRect = { x: newRect.x, y: newRect.y, w: newRect.w, h: newRect.h };
}
/* 同理重映射手动改色层（目标格粒度，格中心对应） */
function remapManualToRect(oldRect, newRect, target) {
  const m = refine.manual;
  if (!m || refine._manualT !== target) return;
  const out = new Int16Array(target * target).fill(EMPTY);
  for (let ty = 0; ty < target; ty++) {
    const py = newRect.y + (ty + 0.5) / target * newRect.h;
    const oyN = (py - oldRect.y) / oldRect.h;
    if (oyN < 0 || oyN >= 1) continue;
    const oy = Math.min(target - 1, (oyN * target) | 0);
    for (let tx = 0; tx < target; tx++) {
      const px = newRect.x + (tx + 0.5) / target * newRect.w;
      const oxN = (px - oldRect.x) / oldRect.w;
      if (oxN < 0 || oxN >= 1) continue;
      const v = m[oy * target + Math.min(target - 1, (oxN * target) | 0)];
      if (v !== EMPTY) out[ty * target + tx] = v;
    }
  }
  refine.manual = out;
}

/* 每格最终用色 = 包边层 > 手动覆盖层 > 自动结果（需求矛盾表第 6 条：手动改色优先） */
function effectiveCells(cells, target) {
  const m = refine.manual;
  const n = target * target;
  const out = new Int16Array(cells);
  if (m && m.length === n) {
    for (let i = 0; i < n; i++) {
      if (m[i] === EMPTY) continue;
      out[i] = (m[i] === CLEARED) ? EMPTY : m[i];   // CLEARED = 用户显式置空，优先于一切
    }
  }
  // 蒙版把非主体格强制置空；但用户补过豆（≠EMPTY）或显式置空（CLEARED）的格子
  // 都是用户的明确意志，优先于蒙版（Story 7.1 补豆/置空双向）
  if (refine.mask) {
    for (let i = 0; i < n; i++) {
      if (m && m.length === n && m[i] !== EMPTY) continue;
      if (!maskCellKept(i, target)) out[i] = EMPTY;
    }
  }
  return out;
}

/* 4.2 历史栈：只存精修层，20 步（需求假设 6）。cells 不存——它是派生数据。 */
const HISTORY_MAX = 20;
let hist = [], histPos = -1;
function snapshot(target) {
  return {
    target: target,
    manual: refine.manual ? refine.manual.slice() : null,
    manualT: refine._manualT,
    mask: refine.mask ? refine.mask.slice() : null,
    maskRect: refine._maskRect ? Object.assign({}, refine._maskRect) : null,
    edge: refine.edge,
    crop: refine.crop ? Object.assign({}, refine.crop) : null,
    sel: refine.sel ? refine.sel.slice() : null
  };
}
function restore(s) {
  refine.manual = s.manual ? s.manual.slice() : null; refine._manualT = s.manualT || 0;
  refine.mask = s.mask ? s.mask.slice() : null;
  refine._maskRect = s.maskRect ? Object.assign({}, s.maskRect) : null;
  refine.edge = s.edge;
  refine.crop = s.crop ? Object.assign({}, s.crop) : null;
  refine.sel = s.sel ? s.sel.slice() : null;
}
function pushHistory(target) {
  hist = hist.slice(0, histPos + 1);
  hist.push(snapshot(target));
  if (hist.length > HISTORY_MAX) hist.shift();
  histPos = hist.length - 1;
  updateHistUI();
}
function undo() {
  // 会话中有未确认改动时，全局撤销会拆散「基线→确认」的结构 —— 先确认或取消
  if (draft.kind && draftChanged()) { toast("当前有未确认的修改，先「确认」或「取消」再撤销", "err"); return; }
  if (histPos <= 0) return;
  histPos--;
  restore(hist[histPos]);
  afterHistoryChange("已撤销");
}
function redo() {
  if (draft.kind && draftChanged()) { toast("当前有未确认的修改，先「确认」或「取消」再重做", "err"); return; }
  if (histPos >= hist.length - 1) return;
  histPos++;
  restore(hist[histPos]);
  afterHistoryChange("已重做");
}
function afterHistoryChange(msg) {
  updateHistUI();
  if (refine.mode === "crop") { syncCropUI(); }
  else if (refine.mode === "matt") { renderEditOverlay(); }
  else { run(); }
  toast(msg);
}
function updateHistUI() {
  $("undo").disabled = histPos <= 0;
  $("redo").disabled = histPos >= hist.length - 1;
  const hasManual = !!(refine.manual && refine.manual.some(function (v) { return v !== EMPTY; }));
  const hasEdge = refine.edge !== EMPTY;
  $("resetAll").disabled = !(hasManual || hasEdge || refine.crop);
  const steps = Math.max(0, histPos);
  $("histnote").textContent = "历史 " + steps + " / " + (HISTORY_MAX - 1) +
    " 步。切换规格 / 色数 / 色号间距会丢弃全部手动修改并重算，届时会先提示。";
}

/* ============================================================
   4.2b 编辑态生命周期（需求 §2.5.1 四态模型的落地）

   实现方式是「实时写入 + 基线快照」，而不是把改动隔离到草稿副本：
   - 进入编辑态（setMode）时拍下相关字段的基线（draft.base）；
   - 编辑过程直接写 refine.* —— 预览实时更新（需求 §2.5.8 假设 14 选了实时显示，
     「边涂边看」对笔刷/改色都是必要的）；
   - 「取消」= 整体恢复基线（未确认即未生效，规则 2）；
   - 「确认」= 有改动才 pushHistory（规则 3：确认后必可撤销；空改动不压栈）。
   历史栈只在确认时写入 —— 编辑过程中的笔划用会话内栈（draft.strokes）
   做「撤销一笔」，不污染全局历史。

   裁剪是特例：它的草稿（cropPendingCrop）天然与生效值（crop）分离，
   不需要基线快照，draftFields 返回空。
   ============================================================ */
const draft = {
  kind: null,                    // 当前编辑态：'crop'|'matt'|'edge'|'edit'；null = 空闲
  base: null,                    // 进入编辑态时的基线（取消 = 恢复到这里）
  strokes: [],                   // 会话内笔划栈（matt 的「撤销一笔」）
  lastClick: { i: -1, t: 0 }     // 改色二次点击的击键窗口（假设 18：<300ms 视为一次操作）
};
function draftFields(kind) {
  if (kind === "matt") return ["mask", "_maskRect"];
  if (kind === "edge") return ["edge"];
  if (kind === "edit") return ["manual"];
  return [];                     // crop：草稿即 cropPendingCrop，天然隔离
}
function draftEnter(kind) {
  draft.kind = kind;
  draft.strokes = [];
  draft.base = {};
  for (const k of draftFields(kind)) {
    const v = refine[k];
    draft.base[k] = (v && typeof v.slice === "function") ? v.slice() : v;
  }
}
function draftReset() {
  draft.kind = null; draft.base = null; draft.strokes = [];
}
function draftChanged() {
  if (!draft.kind) return false;
  if (draft.kind === "crop") {
    const c = refine.cropPendingCrop;
    if (!c) return false;
    return !refine.crop || refine.crop.x !== c.x || refine.crop.y !== c.y ||
      refine.crop.w !== c.w || refine.crop.h !== c.h;
  }
  if (!draft.base) return false;
  for (const k of draftFields(draft.kind)) {
    const a = draft.base[k], b = refine[k];
    if (a === null || b === null) { if (a !== b) return true; continue; }
    if (a.length !== undefined) {
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    } else if (a !== b) return true;
  }
  return false;
}
/* 取消：恢复基线、退出编辑态、重算（需求 §2.5.1「已取消」态） */
function draftCancel() {
  if (!draft.kind) return;
  const kind = draft.kind;
  if (kind !== "crop" && draft.base) {
    for (const k of draftFields(kind)) refine[k] = draft.base[k];
  }
  if (kind === "crop") refine.cropPendingCrop = null;
  draftReset();
  masterSig = "";
  setMode("none", true);
  run();
  toast("已取消，未做任何修改", "info");
}
/* 确认：有改动才写历史；裁剪走 cropApply（含工作区重映射） */
function draftConfirm() {
  if (!draft.kind) return;
  const kind = draft.kind;
  if (kind === "crop") { $("cropApply").click(); return; }
  const changed = draftChanged();
  draftReset();
  if (changed) {
    pushHistory(state.target);
    setMode("none", true);
    run();
    toast("修改已确认", "ok");
  } else {
    setMode("none", true);
    toast("没有需要确认的修改", "info");
  }
}

/* 当前是否存在「会因重算而被丢弃」的精修成果（供参数守卫共用） */
function refineDirty() {
  const hasManual = !!(refine.manual && refine.manual.some(function (v) { return v !== EMPTY; }));
  return hasManual || refine.edge !== EMPTY || !!refine.mask ||
    !!(draft.kind && draftChanged());
}

/* 4.3 关键：任何会改变自动结果的操作，都必须把精修层作废并告知用户。
   需求矛盾表第 6 条与假设 7 明确要求「改色后切换规格/色数会丢弃手动修改并需提示」。 */
function invalidateRefine(reason) {
  if (!refineDirty()) return true;
  const hasManual = !!(refine.manual && refine.manual.some(function (v) { return v !== EMPTY; }));
  const hasEdge = refine.edge !== EMPTY;
  const hasMask = !!refine.mask;
  const hasDraft = !!(draft.kind && draftChanged());
  const what = [];
  if (hasDraft) what.push("未确认的编辑");
  if (hasManual) what.push("逐格改色");
  if (hasEdge) what.push("包边");
  if (hasMask) what.push("抠图蒙版");
  if (!confirm("切换" + reason + "会重新挑选色号与重算网格，已做的" + what.join(" / ") +
    "将被丢弃。要继续吗？\n\n（选择「取消」则保留当前图纸，参数不生效）")) {
    return false;
  }
  if (hasDraft) draftReset();
  refine.cropPendingCrop = null;
  refine.manual = null; refine._manualT = 0;
  refine.mask = null; refine._maskRect = null;
  refine.sel = null;
  refine.edge = EMPTY;
  hist = []; histPos = -1;
  updateHistUI();
  updateEdgeSwatch();
  return true;
}

/* 预滤波已移除：实测（干净图 + σ=11 噪点图 + JPEG q55）
   全图高斯预滤波与碎块吸收对「背景斑驳」均无可见改善，
   真正的病根是「量化放大」，解法在 2.6 的平坦区统一，且预处理还会软化细节。 */

const state = { target: 78, N: 24, thr: 0.02 };
const tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
const isNarrow = function () { return window.matchMedia(NARROW).matches; };

/* ============================================================
   4.1 反馈组件：Toast / 状态行 / 进度条 / 生成中遮罩
   ============================================================ */
const ICON = { ok: "✓", err: "!", info: "·" };

function toast(msg, kind) {
  const box = $("toasts");
  if (!box) return;
  while (box.children.length > 2) box.removeChild(box.firstChild);
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = ICON[kind] || ICON.info;
  const tx = document.createElement("span");
  tx.textContent = msg;
  el.appendChild(ic);
  el.appendChild(tx);
  box.appendChild(el);
  setTimeout(function () {
    el.classList.add("out");
    setTimeout(function () { el.remove(); }, 240);
  }, kind === "err" ? 3600 : 2400);
}

function setStatus(text, mode) {
  $("status").className = "status" + (mode ? " " + mode : "");
  $("stext").textContent = text;
}

function setBusy(on, text) {
  running = on;
  $("ov").classList.toggle("show", on && showVeil);
  $("prog").classList.toggle("show", on);
  $("run").innerHTML = on ? '<span class="spin"></span>生成中…' : "生成图纸";
  $("run").disabled = on || !imageData;
  $("save").disabled = on || !lastResult;
  if (on && text) { $("ovtext").textContent = text; setStatus(text, "busy"); }
}

/* 还没传图就调参时，给一次轻微提醒而不是默默无反应 */
function nudge(msg) {
  toast(msg || "先上传一张图片，参数改完会自动生效");
  const d = $("drop");
  d.classList.remove("shake");
  void d.offsetWidth;
  d.classList.add("shake");
}

/* 滑杆已填充比例 */
function fillRange(el) {
  const min = +el.min, max = +el.max;
  const p = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--p", p.toFixed(2) + "%");
}

/* 成品边长提示：N 格 × 2.6mm */
function updateSizeHint() {
  const cm = (state.target * 0.26).toFixed(1);
  $("sizeHint").textContent = "成品 " + cm + " cm 见方";
}

/* 解码：优先带 EXIF 方向；个别浏览器不支持该参数时退回默认解码 */
async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    return await createImageBitmap(file);
  }
}

/* 画布：优先 OffscreenCanvas，不支持时退回到离屏 canvas 元素 */
function workingCanvas(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

async function loadFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || "")) {
    toast("这不是图片文件，换一张试试", "err");
    return;
  }

  setStatus("正在解码图片…", "busy");
  $("prog").classList.add("show");
  $("drop").classList.remove("is-over");

  try {
    const bmp = await decodeImage(file);
    const w = bmp.width, h = bmp.height;
    imageWH = [w, h];

    // 预降采样到 MAX_SRC，控制后续遍历成本
    const side = Math.max(w, h);
    const k = side > MAX_SRC ? MAX_SRC / side : 1;
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
    const oc = workingCanvas(dw, dh);
    const octx = oc.getContext("2d", { willReadFrequently: true });
    octx.imageSmoothingQuality = "high";
    octx.drawImage(bmp, 0, 0, dw, dh);
    imageData = octx.getImageData(0, 0, dw, dh);
    if (bmp.close) bmp.close();

    // 上传回显：缩略图 + 文件名 + 尺寸
    imageName = file.name || "pasted.png";
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = URL.createObjectURL(file);
    $("thumb").src = imageURL;
    $("fname").textContent = imageName;
    $("fname").title = imageName;
    $("fdim").textContent = k < 1 ? w + "×" + h + " → " + dw + "×" + dh : w + " × " + h + " px";
    $("drop").classList.add("has-file");
    $("ready").classList.add("show");

    master = null; masterOk = null; masterW = null;
    lastResult = null;
    // 换图等于换了一切：裁剪 / 抠图 / 包边 / 改色全部作废（它们都锚定在原图上）。
    // force 退出编辑态 —— 用户已经在文件选择器里明确换了图，无需再问一次
    draftReset();
    refine.crop = null; refine.cropPendingCrop = null;
    clearMask(); refine.edge = EMPTY;
    refine.manual = null; refine._manualT = 0;
    refine.sel = null;
    hist = []; histPos = -1;
    if (refine.mode !== "none") setMode("none", true);
    updateHistUI(); updateEdgeSwatch(); updateFxGates();
    $("prog").classList.remove("show");
    setBusy(false);
    updateInfo();
    setStatus("图片已就绪，点「生成图纸」开始转换", "done");
    toast("已载入 " + w + "×" + h + " 图片", "ok");

    // 换成新图后如果之前生成过，自动重算一次，省一次点击
    if (everRan) run();
  } catch (err) {
    $("prog").classList.remove("show");
    setBusy(false);
    setStatus("图片解码失败，可能格式不受支持", "err");
    toast("解码失败：" + (err && err.message ? err.message : "未知错误"), "err");
  }
}

async function run() {
  if (!imageData) { nudge("先上传一张图片，再点生成"); return; }
  if (running) { pending = true; return; }   // 正在跑时记一次待办，跑完自动补

  const myToken = ++runToken;                // Story 3.2：以最新参数为准，旧代次结果一律丢弃
  const first = !everRan;
  // 首次生成 / 窄屏（侧栏可能不在视野内）才盖大遮罩；之后的快速重算只走细进度条，避免闪烁
  showVeil = first || isNarrow();
  const t0 = performance.now();
  setBusy(true, "正在重采样到 312×312 主网格并提取主导色…");
  await tick();

  try {
    // 主网格分析的结果只依赖「像素集合」（裁剪 + 蒙版），不依赖色数/档位。
    // 但裁剪与蒙版都会变，所以这里用签名判断缓存是否仍然有效，避免每次都重算 100ms+。
    const sig = masterSignature();
    if (!master || masterSig !== sig) {
      const weights = buildWeights(refine.mask ? resampleMaskToSource() : null);
      const res = analyzeMaster(imageData, workRect(), weights);
      master = res.rgb; masterW = res.weight;
      masterOk = buildMasterOk(master);
      masterSig = sig;
      await tick();
      if (myToken !== runToken) return;      // 已有更新的请求在跑，本次结果作废
    }

    setBusy(true, "正在剔除近重复色并挑选调色板…");
    await tick();
    let poolIdx = suppressNearDuplicates(PALETTE, state.thr);
    const t1 = performance.now();

    // 从 312 主网格等距采样作为贪心加色的目标分布。空格不参与：
    // 它们是「不放豆的地方」，把它们算进选色样本会浪费色号去拟合背景
    const SAMPLES = 1024, stepAll = (MASTER * MASTER) / SAMPLES;
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const idx = Math.floor(i * stepAll);
      if (masterW[idx] < MASTER_EMPTY_W) continue;
      const p = idx * 3;
      samples.push([masterOk[p], masterOk[p + 1], masterOk[p + 2]]);
    }
    if (!samples.length) throw new Error("这张图里没有可转换的像素（可能裁剪框或蒙版把所有内容都排除了）");

    let curve = [];
    const palIdx = greedyPalette(samples, poolIdx, state.N, function (c) { curve = c; });
    lastPoolLen = poolIdx.length;
    const t2 = performance.now();
    if (!palIdx.length) throw new Error("没有选出任何色号，请把色数调大一点");

    setBusy(true, "正在把 312 主网格归入调色板…");
    await tick();
    const idxAll = assignAll(masterOk, masterW, palIdx);
    const t3 = performance.now();

    const srcOk = targetSourceOk(masterOk, masterW, state.target);
    const cellsRaw = downsampleByMode(idxAll, state.target, srcOk, masterW, palIdx);
    // Step 6.5：平坦区统一 / 导向滤波 两选一，按指标自评择优（§2.9、§0.5.3）。不叠加。
    const consist = chooseConsistency(cellsRaw, srcOk, state.target, palIdx);
    const cells = consist.cells;
    lastConsist = consist.detail;
    const t4 = performance.now();

    ensureManual(state.target);
    ensureSel(state.target);
    if (histPos < 0) pushHistory(state.target);      // 初版结果作为历史起点

    setBusy(true, "正在绘制图纸与色卡集合版…");
    await tick();
    const t5 = performance.now();

    paint(cells, state.target, t0, t1, t2, t3, t4, t5, curve);
    everRan = true;
    // 首次出图后自动展开精修区：否则入口藏在折叠面板里，用户不会发现 P1 功能
    if (first && !$("fxwrap").open) {
      $("fxwrap").open = true;
      $("fxhint").textContent = "在右侧预览上操作。图上方的工具条带「撤销 / 重置 / 完成」。";
    }
    await tick();
    if (myToken !== runToken) return;               // 渲染后再次确认代次

    // 首次生成后，窄屏自动把预览滚进视野
    if (first && isNarrow()) {
      try { $("stage").scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { }
    }
    if (!hintedMobile && isNarrow()) {
      hintedMobile = true;
      setTimeout(function () { toast("图纸已生成，可点「下载 PNG」保存"); }, 500);
    }
  } catch (err) {
    if (myToken !== runToken) return;
    setBusy(false);
    setStatus("生成失败：" + (err && err.message ? err.message : "未知错误"), "err");
    toast("生成失败，请重试或换一张图片", "err");
  } finally {
    $("run").disabled = !imageData;
    $("save").disabled = !lastResult;
    updateFxGates();
    if (pending && !running) { pending = false; run(); }
  }
}

/* 主网格分析的缓存签名：任何影响「哪些像素参与转换」的改动都必须让它失效 */
function masterSignature() {
  const c = refine.crop;
  return (c ? c.x + "," + c.y + "," + c.w + "," + c.h : "full") + "|" +
    (refine.mask ? maskHash() : "nomask");
}
function maskHash() {
  if (!refine.mask) return "0";
  let h = 2166136261;
  const m = refine.mask;
  // 全量哈希（旧版每 7 位采一个，单格笔刷改动可能落在采样点上之外而不触发重算）
  for (let i = 0; i < m.length; i++) { h ^= m[i]; h = (h * 16777619) >>> 0; }
  return h.toString(36);
}

/* 把「目标网格粒度」的蒙版重采样回原图像素粒度，供主网格分析使用。
   蒙版是在预览档位上涂的（那个粒度用户看得见、笔刷可控），
   但主网格分析需要逐像素权重，所以这里做一次最近邻放大。 */
/* 蒙版 → 原图像素粒度权重：一律经工作区归一化换算。
   旧实现按「整幅 W×H 归一化」铺放，与 analyzeMaster 的居中方裁是两套坐标 ——
   非方形图上同一像素会被两套规则分进不同的格子，这就是错位的直接来源。 */
function resampleMaskToSource() {
  if (!refine.mask || !imageData) return null;
  const R = refine._maskRect || workRect();
  const W = imageData.width, H = imageData.height;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const uy = (y + 0.5 - R.y) / R.h;
    if (uy < 0 || uy >= 1) continue;             // 工作区外权重 0（analyzeMaster 不会读到）
    const my = Math.min(MASK_N - 1, (uy * MASK_N) | 0);
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const ux = (x + 0.5 - R.x) / R.w;
      if (ux < 0 || ux >= 1) continue;
      out[row + x] = refine.mask[my * MASK_N + Math.min(MASK_N - 1, (ux * MASK_N) | 0)] ? 255 : 0;
    }
  }
  return out;
}

/* 绘制当前状态到画布，并刷新统计面板 */
/* 改色会话中「改过哪些格」：manual 与基线的逐格差异，用于虚线标记 */
function draftDiffCells() {
  if (draft.kind !== "edit" || !draft.base || !draft.base.manual || !refine.manual) return null;
  if (draft.base.manual.length !== refine.manual.length) return null;
  const d = new Uint8Array(refine.manual.length);
  let n = 0;
  for (let i = 0; i < d.length; i++) {
    if (refine.manual[i] !== draft.base.manual[i]) { d[i] = 1; n++; }
  }
  return n ? d : null;
}
function paint(cells, target, t0, t1, t2, t3, t4, t5, curve) {
  const eff = effectiveCells(cells, target);
  const layer = computeEdgeLayer(eff, target, refine.edge);
  const meta = render(eff, target, layer, refine.sel, ctx, { draft: draftDiffCells() });
  lastResult = {
    cells: eff, target: target, layer: layer, meta: meta, curve: curve, poolLen: lastPoolLen,
    metrics: gridMetrics(eff, targetSourceOk(masterOk, masterW, target), target, null, layer)
  };
  cv.hidden = false;
  $("empty").style.display = "none";
  applyZoom();
  setBusy(false);

  const total = target * target;
  const worstErr = curve && curve.length ? curve[curve.length - 1] : 0;
  setStatus("完成 · " + meta.used.length + " 色 / " + meta.usage.total.toLocaleString() +
    " 颗" + (meta.usage.empty ? "（空 " + meta.usage.empty + " 格）" : "") +
    " · 耗时 " + Math.round((t5 || performance.now()) - t0) + " ms", "done");

  const m = lastResult.metrics;
  $("stats").className = "stats show";
  $("stats").innerHTML =
    "<h4>本次结果</h4>" +
    row("实际用色", meta.used.length + " 色 / 上限 " + state.N + " 色") +
    row("可用色池", (lastResult.poolLen || "—") + " / 221") +
    row("总颗数", meta.usage.total.toLocaleString() + " 颗") +
    (meta.usage.empty ? row("空格", meta.usage.empty.toLocaleString() + " 格（不放豆）") : "") +
    (meta.usage.edge ? row("含包边", meta.usage.edge.toLocaleString() + " 颗") : "") +
    row("成品尺寸", (target * 0.26).toFixed(1) + " × " + (target * 0.26).toFixed(1) + " cm") +
    row("最差色差", worstErr.toFixed(4)) +
    row("源色误差 p50/p90/max", m.p50.toFixed(4) + " / " + m.p90.toFixed(4) + " / " + m.max.toFixed(4)) +
    row("无意义碎块", (m.frag * 100).toFixed(2) + " %") +
    (lastConsist ? row("空间一致性", lastConsist.chosen +
      "（统一 p90 " + lastConsist.unify.p90.toFixed(4) + " / 滤波 p90 " + lastConsist.guided.p90.toFixed(4) +
      "；幻影 " + (lastConsist.unify.ph * 100).toFixed(1) + "% / " + (lastConsist.guided.ph * 100).toFixed(1) + "%）") : "") +
    '<div class="sep"></div><h4>耗时明细</h4>' +
    row("主网格分析", Math.round(t1 - t0) + " ms", true) +
    row("选色", Math.round(t2 - t1) + " ms", true) +
    row("归属", Math.round(t3 - t2) + " ms", true) +
    row("降采样 + 统一", Math.round(t4 - t3) + " ms", true) +
    row("渲染", Math.round((t5 || performance.now()) - t4) + " ms", true);
  updateFxSum();
  updateEdgeWarn();     // 包边「被画幅裁掉」的就地提示要跟最新结果走（§2.5.6）
}


function row(k, v, sub) {
  return '<div class="r' + (sub ? " sub" : "") + '"><span>' + k + "</span><b>" + v + "</b></div>";
}

/* ============================================================
   5. 交互
   ============================================================ */
/* 固定显示档位（P1 交互优化）：不再提供 50% / 100% / 适应宽度档位。
   生成的整张图纸（网格 + 色卡集合版）按 .stage 可视区内切适配（contain），
   一屏完整呈现 —— 用户无需滚动、放大或缩小即可看到全部内容。
   窗口尺寸变化时由 init.js 的 resize 监听自动重适配。 */
function applyZoom() {
  const st = $("stage");
  if (!st || !cv.width || !cv.height) return;
  // .stage 是 flex 容器、#cv 由 margin:auto 居中：可用区 = 内容盒（client 尺寸减内边距）
  const cs = getComputedStyle(st);
  const availW = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  const k = Math.min(availW / cv.width, availH / cv.height);
  cv.style.width = Math.max(1, Math.round(cv.width * k)) + "px";
  cv.style.height = "auto";                    // 画布有固有宽高比，height:auto 等比跟随
}
