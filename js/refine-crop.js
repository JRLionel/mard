"use strict";
/* ---------- 6.1 模式切换 ---------- */
function setMode(mode, force) {
  // 切换守卫（需求 §2.5.2 A 末条）：编辑中有未确认改动、且是切去「别的工具」时先问。
  // 切回 none（再点同一工具 / 点取消）不问 —— 需求 §2.5.2 C 把它定义为「等同于取消」。
  if (!force && mode !== refine.mode && refine.mode !== "none" &&
    draft.kind === refine.mode && draftChanged()) {
    const what = { crop: "裁剪框调整", matt: "笔刷修正", edge: "包边选择", edit: "改色" }[refine.mode] || "修改";
    if (!confirm("当前" + what + "尚未确认，切换将放弃这些修改。要继续吗？")) return;
    if (refine.mode !== "crop" && draft.base) {
      for (const k of draftFields(refine.mode)) refine[k] = draft.base[k];
    }
    if (refine.mode === "crop") refine.cropPendingCrop = null;
    masterSig = "";
    run();
  }
  if (mode === "none") draftReset();
  else if (mode !== refine.mode || draft.kind !== mode) draftEnter(mode);
  refine.mode = mode;
  const wantCrop = mode === "crop", wantMatt = mode === "matt";
  const wantEdit = mode === "edit", wantEdge = mode === "edge";

  Array.prototype.forEach.call($("tools").children, function (b) {
    const on = b.dataset.tool === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("p-crop").classList.toggle("show", wantCrop);
  $("p-matt").classList.toggle("show", wantMatt);
  $("p-edge").classList.toggle("show", wantEdge);
  $("p-edit").classList.toggle("show", wantEdit);

  // 「改色」不需要把画布换成原图——它作用在已渲染的网格图上，
  // 继续用 #cv 才能让用户看清色号（这也是 Story 7.1 交互的地基）
  const needOverlayView = wantCrop || wantMatt;
  $("stage").classList.toggle("is-editing", needOverlayView);
  editwrap.classList.toggle("show", needOverlayView);
  document.body.classList.toggle("editing", needOverlayView);
  cropbox.hidden = !wantCrop;
  // 改色模式下水印 canvas 仍可见，但要让它可点
  cv.style.cursor = wantEdit ? "crosshair" : "";
  cv.style.pointerEvents = wantEdit ? "auto" : "";

  if (needOverlayView) {
    editimg.src = imageURL;
    requestAnimationFrame(function () {
      fitView();
      if (wantCrop) syncCropUI();
      renderEditOverlay();
      buildEditBar();
    });
  } else {
    // 改色/包边不需要 overlay 视图，但编辑条（取消/确认）照常显示 ——
    // 没有出口的编辑态是 v1.2 的核心缺陷（需求 §2.5.1 规则 1：进入必有出口）
    if (wantEdit || wantEdge) { buildEditBar(); }
    else { editbar.style.display = "none"; }
    if (wantEdit && refine.sel) repaintWithSel();
  }
}

/* ---------- 6.2 精修视口：适配 / 缩放 / 平移 ---------- */
function fitView() {
  const r = editwrap.getBoundingClientRect();
  if (!r.width || !imageData) return;
  const iw = imageData.width, ih = imageData.height;
  const s = Math.min(r.width / iw, r.height / ih);
  view.s = s; view.fit = s;
  view.iw = iw; view.ih = ih;
  view.ox = 0; view.oy = 0;
  view.tx = (r.width - iw * s) / 2;
  view.ty = (r.height - ih * s) / 2;
  applyView();
}
function applyView() {
  const t = "translate(" + view.tx + "px," + view.ty + "px) scale(" + view.s + ")";
  editimg.style.transform = t;
  editimg.style.width = view.iw + "px";
  editimg.style.height = view.ih + "px";
  editov.style.transform = t;
  cropbox.style.transform = t;
  // 手柄反向缩放：.cropbox 整体带 scale(view.s)，手柄作为子元素命中区会跟着缩
  // （fit 档 22px 实际只有 ~13px，触屏点不中）。反向缩放（原点=中心，角点不动）
  // 保证屏幕命中区恒 ≥ 基准尺寸；深放大时用下限兜底。
  const inv = Math.max(1 / view.s, 0.92).toFixed(4);
  Array.prototype.forEach.call(cropbox.querySelectorAll(".ch"), function (h) {
    h.style.transform = "scale(" + inv + ")";
  });
}
function zoomBy(factor, cx, cy) {
  const r = editwrap.getBoundingClientRect();
  if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
  const ns = Math.max(view.fit * 0.5, Math.min(view.fit * 14, view.s * factor));
  const k = ns / view.s;
  // 以鼠标位置为锚点缩放
  view.tx = cx - (cx - view.tx) * k;
  view.ty = cy - (cy - view.ty) * k;
  view.s = ns;
  applyView();
  renderEditOverlay();
}
/* 屏幕坐标 → 图片坐标（原图像素） */
function toImage(clientX, clientY) {
  const r = editwrap.getBoundingClientRect();
  const x = (clientX - r.left - view.tx) / view.s;
  const y = (clientY - r.top - view.ty) / view.s;
  return { x: x, y: y };
}

editwrap.addEventListener("wheel", function (e) {
  e.preventDefault();
  const r = editwrap.getBoundingClientRect();
  zoomBy(e.deltaY < 0 ? 1.14 : 1 / 1.14, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

/* ---------- 6.3 E9 裁剪 ---------- */
// 裁剪框是「非破坏性」的：它只是一组原图坐标，随时可改、可清。
// 图纸映射时若裁剪区不是正方形，按需求假设 10 采用「居中裁切补足、不拉伸」。
const cropRatio = { v: 0 };
function defaultCrop() {
  const w = imageData.width, h = imageData.height;
  const side = Math.min(w, h);
  return { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side };
}
function syncCropUI() {
  const c = refine.cropPendingCrop || refine.crop || defaultCrop();
  refine.cropPendingCrop = Object.assign({}, c);
  drawCropBox();
  $("cropApply").disabled = false;
  updateCropInfo();
}
function drawCropBox() {
  const c = refine.cropPendingCrop;
  if (!c) return;
  cropbox.style.left = c.x + "px";
  cropbox.style.top = c.y + "px";
  cropbox.style.width = c.w + "px";
  cropbox.style.height = c.h + "px";
}
function updateCropInfo() {
  const c = refine.cropPendingCrop;
  if (!c) { editbar.innerHTML = ""; return; }
  const ar = c.w / c.h;
  const isSq = Math.abs(ar - 1) < 0.01;
  editbar.style.display = "flex";
  editbar.innerHTML =
    '<span class="mm">' + Math.round(c.w) + " × " + Math.round(c.h) + " px · " + ar.toFixed(2) + ":1</span>" +
    '<span class="sep"></span>' +
    '<span>' + (isSq ? "正方形，全部内容进入图纸" : "非正方形：取虚线框内的居中正方形，两侧内容不进入图纸") + "</span>" +
    '<span class="sep"></span>' +
    '<button data-a="cancel">取消</button>' +
    '<button data-a="fit">适应</button>' +
    '<button data-a="reset">全图</button>' +
    '<button data-a="confirm" class="solid">确认裁剪</button>';
}
const CROP_MIN = 24;                 // 裁剪框最小边长（原图像素）
function clampCrop(c) {
  const w = imageData.width, h = imageData.height;
  const ar = cropRatio.v;
  // 先按比例把边长定下来，再夹进画幅——顺序反了会出现「夹完再乘比例又超界」
  if (ar) {
    c.w = Math.max(CROP_MIN, Math.min(w, c.w));
    c.h = c.w / ar;
    if (c.h > h) { c.h = h; c.w = c.h * ar; }
    if (c.h < CROP_MIN) { c.h = CROP_MIN; c.w = c.h * ar; }
  } else {
    c.w = Math.max(CROP_MIN, Math.min(w, c.w));
    c.h = Math.max(CROP_MIN, Math.min(h, c.h));
  }
  // 位置夹取：允许贴边，但不许越界。注意 w/h 先算好，否则 w-c.w 会算出负的可用区间
  c.x = Math.max(0, Math.min(w - c.w, c.x));
  c.y = Math.max(0, Math.min(h - c.h, c.y));
  return c;
}

let cropDrag = null;
editwrap.addEventListener("pointerdown", function (e) {
  if (refine.mode !== "crop") return;
  // 编辑条不是裁剪框的一部分（大框会罩住底部工具条，点按钮会被当成拖框）
  if (e.target.closest && e.target.closest("#editbar")) return;
  const handle = e.target.dataset && e.target.dataset.h;
  const p = toImage(e.clientX, e.clientY);
  const c = refine.cropPendingCrop;
  const inBox = p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
  if (!handle && !inBox) return;
  e.preventDefault();
  try { editwrap.setPointerCapture(e.pointerId); } catch (err) { /* 同上，优化项失败不影响功能 */ }
  cropDrag = {
    h: handle || "move",
    sx: p.x, sy: p.y,
    box: Object.assign({}, c)
  };
});
editwrap.addEventListener("pointermove", function (e) {
  if (!cropDrag) return;
  const p = toImage(e.clientX, e.clientY);
  const dx = p.x - cropDrag.sx, dy = p.y - cropDrag.sy;
  const b = cropDrag.box, c = Object.assign({}, b);
  const H = cropDrag.h;
  if (H === "move") { c.x = b.x + dx; c.y = b.y + dy; }
  else {
    if (H.indexOf("w") >= 0) { c.x = b.x + dx; c.w = b.w - dx; }
    if (H.indexOf("e") >= 0) { c.w = b.w + dx; }
    if (H.indexOf("n") >= 0) { c.y = b.y + dy; c.h = b.h - dy; }
    if (H.indexOf("s") >= 0) { c.h = b.h + dy; }
    // 比例预设：锚点约束（需求 §2.5.4「不破坏比例且不跳变」）。
    // 角柄锚住**对角**（nw 锚 se、ne 锚 sw…），边柄锚住垂直方向的**中心** ——
    // 旧实现只改对边尺寸不动位置，拖角时整框会漂移。
    if (cropRatio.v && H !== "move") {
      const ar = cropRatio.v;
      if (H === "n" || H === "s") {
        c.w = c.h * ar;
        c.x = b.x + (b.w - c.w) / 2;
      } else if (H === "w" || H === "e") {
        c.h = c.w / ar;
        c.y = b.y + (b.h - c.h) / 2;
      } else {
        c.h = c.w / ar;
        if (H.indexOf("n") >= 0) c.y = b.y + b.h - c.h; else c.y = b.y;
        if (H.indexOf("w") >= 0) c.x = b.x + b.w - c.w; else c.x = b.x;
      }
    }
  }
  refine.cropPendingCrop = clampCrop(c);
  drawCropBox();
  updateCropInfo();
});
["pointerup", "pointercancel"].forEach(function (t) {
  editwrap.addEventListener(t, function () {
    if (!cropDrag) return;
    cropDrag = null;
    updateCropInfo();
  });
});

$("cropratio").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  markOn(this, b);
  cropRatio.v = parseFloat(b.dataset.r);
  const c = refine.cropPendingCrop;
  if (cropRatio.v) {
    // 按新比例重算一个「以原框中心为中心、尽量大」的框
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let w = Math.min(imageData.width, c.w);
    let h = w / cropRatio.v;
    if (h > imageData.height) { h = imageData.height; w = h * cropRatio.v; }
    c.w = w; c.h = h; c.x = cx - w / 2; c.y = cy - h / 2;
    refine.cropPendingCrop = clampCrop(c);
  }
  drawCropBox();
  updateCropInfo();
});
$("cropReset").addEventListener("click", function () {
  refine.cropPendingCrop = defaultCrop();
  clampCrop(refine.cropPendingCrop);
  drawCropBox();
  updateCropInfo();
});
$("cropApply").addEventListener("click", function () {
  const c = refine.cropPendingCrop;
  if (!c) return;
  const oldRect = workRect();           // 重映射的源：确认前的工作区
  const changed = !refine.crop || refine.crop.x !== c.x || refine.crop.y !== c.y ||
    refine.crop.w !== c.w || refine.crop.h !== c.h;
  refine.crop = Object.assign({}, c);
  masterSig = "";                       // 裁剪变了，主网格必须重算
  if (changed) {
    const newRect = workRect();
    // 蒙版与改色层从旧工作区重映射到新工作区：重叠保留、超出丢弃
    // （需求矛盾表第 8 条 / 假设 12）—— 旧实现用第三套坐标（整幅归一化）做区间
    // 裁切，与出图区域对不上，属于坐标错位的一部分
    remapMaskToRect(oldRect, newRect);
    remapManualToRect(oldRect, newRect, state.target);
    pushHistory(state.target);
  }
  // 确认 = 写入并回到空闲态（§2.5.1「已应用」）。想继续调整就再点一次「裁剪」
  // 重新进入（规则 4：编辑器可再入），pending 会从已确认的 crop 重新初始化。
  draftReset();
  syncCropUI();
  run();
  setMode("none", true);
  toast(changed ? "裁剪已应用（工作区已更新，框外修改已丢弃）" : "裁剪框没有变化", "ok");
});
$("cropClear").addEventListener("click", function () {
  if (!refine.crop && !refine.cropPendingCrop) return;
  const oldRect = workRect();
  refine.crop = null;
  refine.cropPendingCrop = null;
  const newRect = workRect();           // 恢复完整图 = 工作区回到整幅居中方裁
  masterSig = "";
  remapMaskToRect(oldRect, newRect);    // 蒙版跟着工作区重映射，否则又错位
  remapManualToRect(oldRect, newRect, state.target);
  pushHistory(state.target);
  syncCropUI();
  run();
  toast("已恢复为完整图（蒙版与改色已按新工作区重映射）", "ok");
});
/* Story 9.1 的「重叠保留、超出丢弃」已由 remapMaskToRect / remapManualToRect 实现
   （见上）。旧函数 applyCropKeepOverlap 用「整幅归一化」做区间裁切，与出图区域
   （工作区坐标系）对不上，是三套坐标错位的一部分，已删除。 */
