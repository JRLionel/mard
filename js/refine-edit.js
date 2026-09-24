"use strict";
/* ---------- 6.5 E6 包边 ---------- */
function buildEdgePicker() {
  const box = $("edgepick");
  if (box.children.length) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < PALETTE.length; i++) {
    const b = document.createElement("button");
    b.dataset.pi = i;
    b.style.backgroundColor = PALETTE[i].hex;   // 只设颜色：衬底棋盘格由 CSS 提供，
    b.title = PALETTE[i].code + " " + PALETTE[i].hex;   // 否则近白色号在白底上不可见
    b.setAttribute("aria-label", "包边色 " + PALETTE[i].code);
    frag.appendChild(b);
  }
  box.appendChild(frag);
}
buildEdgePicker();
$("edgepick").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  const pi = +b.dataset.pi;
  Array.prototype.forEach.call(this.children, function (x) { x.classList.remove("on"); });
  b.classList.add("on");
  refine.edge = (refine.edge === pi) ? EMPTY : pi;      // 再点一次 = 关闭包边
  if (refine.edge === EMPTY) { b.classList.remove("on"); toast("已关闭包边"); }
  // 选色 = 预览实时更新，但未确认；「确认」才写历史（需求 §2.5.6）
  updateEdgeSwatch(); updateFxSum(); updateInfo();
  if (lastResult) run();
  updateEdgeWarn();
});
/* 包边被画幅裁掉时**就地**提示（需求 §2.5.6 / G3）：一次性 Toast 用户看不见，
   常驻在选色处才能在用户换色时持续说明原因 */
function updateEdgeWarn() {
  const warn = $("edgeClipWarn");
  if (!warn) return;
  if (refine.edge === EMPTY || !lastResult) { warn.hidden = true; return; }
  const clipped = edgeClippedCount(lastResult.cells, state.target, refine.edge);
  if (clipped > 0) {
    warn.hidden = false;
    warn.textContent = "主体铺满整幅：外侧还有 " + clipped +
      " 格包边放不进画幅。先用「抠图」扣掉背景，包边才完整。";
  } else {
    warn.hidden = true;
  }
}
function updateEdgeSwatch() {
  const on = refine.edge !== EMPTY;
  $("edgesw").style.background = on ? PALETTE[refine.edge].hex : "#fff";
  $("edgecode").textContent = on ? PALETTE[refine.edge].code + " " + PALETTE[refine.edge].hex : "未选";
  Array.prototype.forEach.call($("edgepick").children, function (x) {
    x.classList.toggle("on", +x.dataset.pi === refine.edge);
  });
  updateFxSum();
}

/* ---------- 6.6 E7 改色 ---------- */
buildEditPicker();
function buildEditPicker() {
  const box = $("editpick");
  if (box.children.length) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < PALETTE.length; i++) {
    const b = document.createElement("button");
    b.dataset.pi = i;
    b.style.backgroundColor = PALETTE[i].hex;   // 同上：棋盘格衬底在 CSS 里
    b.title = PALETTE[i].code + " " + PALETTE[i].hex;
    b.setAttribute("aria-label", "替换色 " + PALETTE[i].code);
    frag.appendChild(b);
  }
  box.appendChild(frag);
}
let editColor = EMPTY;
$("editpick").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  Array.prototype.forEach.call(this.children, function (x) { x.classList.remove("on"); });
  b.classList.add("on");
  editColor = +b.dataset.pi;
  $("editsw").style.background = PALETTE[editColor].hex;
  $("editcode").textContent = PALETTE[editColor].code + " " + PALETTE[editColor].hex;
  $("applyColor").disabled = false;
  $("fillEmpty").disabled = false;
});

/* ---------- 连续涂色模式（P1 交互优化）：点色板取色后直接在图纸上点涂 / 拖涂 ----------
   与「选格替换」互斥切换：涂色模式省去「选中→替换」两步，多次点击不同颜色即可
   连续给不同区域上色；原框选批量流程完整保留。改动仍走 manual 覆盖层的会话级
   语义（实时生效、未确认可整体回退、确认才写历史），与 applyColor 一致。 */
let paintMode = false, paintDrag = false, paintedN = 0;
$("paintmode").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  paintMode = (b.dataset.m === "paint");
  markOn(this, b);
  deselectAll();
  $("editnote").textContent = paintMode
    ? "连续涂色：点色板取色，直接在图纸上单击或拖动涂色，可随时换色继续涂。空格不会被涂（补豆用下方按钮）。"
    : "图纸生成后，在右侧画布上单击格子选中，再点一次取消；拖拽框选，Shift 加选。";
});
function paintCell(c) {
  if (!lastResult || !c) return;
  const i = c.i;
  if (lastResult.cells[i] === EMPTY) return;        // 空格不放豆，涂色跳过（补豆走「补成该色」按钮）
  if (lastResult.cells[i] === editColor) return;    // 已是该色
  ensureManual(state.target)[i] = editColor;        // 写覆盖层（会话级，取消可回退）
  lastResult.cells[i] = editColor;                  // 即时上屏；收笔时的 run() 会按 manual 归一
  paintedN++;
  repaintWithSel();                                 // 顺带重算包边层
}

/* 预览画布的坐标 → 格子下标。预览是 1:1 像素映射（宽度由 CSS 缩放），
   所以要把客户端坐标按「显示宽度 / 画布宽度」比例换算回去。 */
function clientToCell(clientX, clientY) {
  if (!lastResult) return null;
  const r = cv.getBoundingClientRect();
  if (!r.width) return null;
  const scale = cv.width / r.width;
  const px = (clientX - r.left) * scale;
  const py = (clientY - r.top) * scale;
  const cell = lastResult.meta.cell, pad = lastResult.meta.pad, t = lastResult.target;
  const gx = Math.floor((px - pad) / cell);
  const gy = Math.floor((py - pad) / cell);
  if (gx < 0 || gy < 0 || gx >= t || gy >= t) return null;
  return { x: gx, y: gy, i: gy * t + gx };
}

let selDrag = null, selBefore = null, selPre = null;
cv.addEventListener("pointerdown", function (e) {
  if (refine.mode !== "edit") return;
  const c = clientToCell(e.clientX, e.clientY);
  if (paintMode) {
    if (!c) return;                                 // 图纸外不涂
    if (editColor === EMPTY) { toast("先在下方色板选一个颜色，再涂", "err"); return; }
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 同上 */ }
    paintDrag = true; paintedN = 0;
    paintCell(c);
    return;
  }
  if (!c) { deselectAll(); return; }   // 点图纸外空白 = 清空全部选中（需求 §2.5.5 A）
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 同上 */ }
  const sel = ensureSel(state.target);
  // selPre：按下前的完整状态 —— 只供 pointerup 判断「这一格原来是否已选中」（toggle 用）
  // selBefore：框选基线 —— Shift=加选（保留旧选中），非 Shift=替换（基线全零）。
  // ★ 旧实现非 Shift 也快照旧选中，applyRectSel 又无条件还原基线 ——
  //   结果「拖框替换」实际是「拖框累加」，上一轮选中会幽灵般混进来（实测 49 格选成 50）。
  selPre = sel.slice();
  if (e.shiftKey) {
    selBefore = sel.slice();
  } else {
    sel.fill(0);
    selBefore = new Uint8Array(sel.length);
  }
  selDrag = { x0: c.x, y0: c.y, x1: c.x, y1: c.y, shift: e.shiftKey };
  applyRectSel();
});
cv.addEventListener("pointermove", function (e) {
  if (paintDrag) { paintCell(clientToCell(e.clientX, e.clientY)); return; }
  if (!selDrag) return;
  const c = clientToCell(e.clientX, e.clientY);
  if (!c) return;
  selDrag.x1 = c.x; selDrag.y1 = c.y;
  applyRectSel();
});
["pointerup", "pointercancel"].forEach(function (t) {
  cv.addEventListener(t, function () {
    if (paintDrag) {
      paintDrag = false;
      if (paintedN) {
        updateInfo(); updateFxSum();
        run();                          // 收笔归一一次：统计 / 用量 / 包边全部按 manual 重算
        toast("已涂 " + paintedN + " 格（未确认，可继续涂或取消）", "ok");
      }
      return;
    }
    if (!selDrag) return;
    const single = selDrag.x0 === selDrag.x1 && selDrag.y0 === selDrag.y1;
    const pressedI = selDrag.y0 * state.target + selDrag.x0;
    const wasSelected = selPre && selPre[pressedI] === 1;   // 按「按下前」状态判断，不受本次清选影响
    const shift = selDrag.shift;
    selDrag = null;
    if (single && !shift) {
      // 二次单击同一格 = 取消该格选中（需求 §2.5.5 A，用户明确要求）。
      // 击键窗口（假设 18）：<300ms 的极快双击视为同一次操作、不触发取消 ——
      // 否则快速双击会表现为「选中又立刻消失」，看起来像点了没反应。
      const now = Date.now();
      const rapid = draft.lastClick.i === pressedI && (now - draft.lastClick.t) < 300;
      if (wasSelected && !rapid) {
        ensureSel(state.target)[pressedI] = 0;
        draft.lastClick = { i: pressedI, t: 0 };
        updateSelUI(); repaintWithSel(); buildEditBar();
        return;
      }
      draft.lastClick = { i: pressedI, t: now };
      // 单击选中后把该格颜色设为当前编辑色：「选中 → 挑新色 → 替换」的连续链路
      const sel = refine.sel;
      let only = -1, n = 0;
      for (let i = 0; i < sel.length; i++) if (sel[i]) { n++; only = i; }
      if (n === 1 && lastResult) {
        const cur = lastResult.cells[only];
        if (cur !== EMPTY) {
          editColor = cur;
          Array.prototype.forEach.call($("editpick").children, function (x) {
            x.classList.toggle("on", +x.dataset.pi === cur);
          });
          $("editsw").style.background = PALETTE[cur].hex;
          $("editcode").textContent = PALETTE[cur].code + " (当前)";
          $("applyColor").disabled = false;
          $("fillEmpty").disabled = false;
        }
      }
    }
    updateSelUI();
    repaintWithSel();
    buildEditBar();
    // 选中是「范围」不是「改动」：不写历史（历史只记确认后的颜色改动）
  });
});
function applyRectSel() {
  const sel = ensureSel(state.target);
  if (!selDrag.shift && selBefore) sel.set(selBefore);
  const x0 = Math.min(selDrag.x0, selDrag.x1), x1 = Math.max(selDrag.x0, selDrag.x1);
  const y0 = Math.min(selDrag.y0, selDrag.y1), y1 = Math.max(selDrag.y0, selDrag.y1);
  const t = state.target;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sel[y * t + x] = 1;
  repaintWithSel();
  updateSelUI();
}
/* 取消选中：一键清空全部选中范围。注意它**不改任何颜色** ——
   与「置为空格」（改图纸内容）是两个操作，命名与行为都不得混淆（需求 §2.5.5 B） */
function deselectAll() {
  if (!refine.sel) return;
  refine.sel.fill(0);
  updateSelUI();
  repaintWithSel();
  buildEditBar();
}
function updateSelUI() {
  if (paintMode) return;   // 连续涂色模式下提示语由 paintmode 切换处维护，不被选中逻辑覆盖
  const sel = refine.sel;
  let n = 0;
  if (sel) for (let i = 0; i < sel.length; i++) if (sel[i]) n++;
  $("editnote").textContent = n
    ? "已选中 " + n + " 格（再次单击可取消该格）。选色后点「替换为选中色」；「置为空格」让选中格不放豆。"
    : "图纸生成后，在右侧画布上单击格子选中，再点一次取消；拖拽框选，Shift 加选。";
}
/* 只重画网格图纸部分（不重算算法）——选中态变化必须即时，不能等一次完整 run() */
function repaintWithSel() {
  if (!lastResult) return;
  paint(lastResult.cells, lastResult.target, performance.now(), 0, 0, 0, 0, 0, lastResult.curve);
}

$("deselectAll").addEventListener("click", deselectAll);
$("selSame").addEventListener("click", function () {
  const sel = refine.sel;
  if (!sel || !lastResult) return;
  // 以「当前选中格」的色号为准；没选任何格时提示先去选
  let ref = EMPTY;
  for (let i = 0; i < sel.length; i++) if (sel[i]) { ref = lastResult.cells[i]; break; }
  if (ref === EMPTY) { toast("先在预览上选一格，再点「同色全选」", "err"); return; }
  sel.fill(0);
  let n = 0;
  for (let i = 0; i < lastResult.cells.length; i++) {
    if (lastResult.cells[i] === ref) { sel[i] = 1; n++; }
  }
  repaintWithSel();
  updateSelUI();
  buildEditBar();
  toast("已选中全部 " + PALETTE[ref].code + " 共 " + n + " 格", "ok");
});

$("applyColor").addEventListener("click", function () {
  const sel = refine.sel;
  if (!sel || editColor === EMPTY || !lastResult) return;
  const t = state.target, m = ensureManual(t);
  let n = 0;
  for (let i = 0; i < sel.length; i++) {
    if (!sel[i]) continue;
    if (lastResult.cells[i] === editColor) continue;   // 已经是这个色就不算改动
    m[i] = editColor; n++;
  }
  if (!n) { toast("选中格已经是这个色号了"); return; }
  // 改动实时生效（预览），但未确认：点「确认」才写历史，点「取消」整轮回退（§2.5.5）
  updateInfo(); updateFxSum();
  run();
  toast("已替换 " + n + " 格为 " + PALETTE[editColor].code + "（未确认，可继续改或取消）", "ok");
});
$("fillEmpty").addEventListener("click", function () {
  const sel = refine.sel;
  if (!sel || editColor === EMPTY || !lastResult) return;
  const t = state.target, m = ensureManual(t);
  let n = 0;
  for (let i = 0; i < sel.length; i++) {
    if (!sel[i]) continue;
    if (lastResult.cells[i] !== EMPTY) continue;      // 只对当前为「空」的格补豆
    m[i] = editColor;
    maskCellSet(i, t, 1);                             // 蒙版同步补回：这格重新算主体
    n++;
  }
  if (!n) { toast("选中格中没有「空」格", "err"); return; }
  masterSig = "";
  updateInfo(); updateFxSum();
  run();
  toast("已给 " + n + " 个空格补上 " + PALETTE[editColor].code + "（未确认）", "ok");
});
/* 「置为空格」：把选中格显式置空。写 CLEARED（-2）而不是 EMPTY（-1）——
   EMPTY 表示「覆盖层没改过」，蒙版判它属于主体时格子仍会被着色；
   CLEARED 表示「用户要求这格就是空」，优先于蒙版。旧实现写 EMPTY，
   导致「置为空」对未被抠图的格子完全不生效（验收 7.1f 曾因此假通过）。 */
$("clearSel").addEventListener("click", function () {
  const sel = refine.sel;
  if (!sel) return;
  const t = state.target, m = ensureManual(t);
  let n = 0;
  for (let i = 0; i < sel.length; i++) {
    if (!sel[i]) continue;
    m[i] = CLEARED; n++;
  }
  if (!n) { toast("没有选中任何格", "err"); return; }
  updateInfo(); updateFxSum();
  run();
  toast("已把 " + n + " 格置为空（未确认）", "ok");
});

/* ---------- 6.6b Esc 与页面卸载保护（需求 §2.5.2 A / B） ---------- */
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  const tag = e.target && e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;    // 输入控件里不抢 Esc
  if (draft.kind && draftChanged()) { draftCancel(); return; }   // 编辑态有改动 → 取消
  if (refine.mode !== "none") { setMode("none"); return; }       // 编辑态无改动 → 退出
  if (refine.sel && refine.sel.some(function (v) { return v; })) {  // 空闲态 → 清空选中
    deselectAll();
  }
});
window.addEventListener("beforeunload", function (e) {
  if (draft.kind && draftChanged()) {   // 有未确认改动时刷新/关闭要先确认（§2.5.2 B）
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ---------- 6.7 工具按钮与编辑条 ---------- */
$("tools").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  const t = b.dataset.tool;
  setMode(refine.mode === t ? "none" : t);
});
editbar.addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  const a = b.dataset.a;
  if (a === "fit") { fitView(); renderEditOverlay(); }
  else if (a === "reset") { $("cropReset").click(); }            // 裁剪：全图
  else if (a === "maskonly") {
    mattOverlayStyle = mattOverlayStyle === "blend" ? "only" : "blend";
    renderEditOverlay();
    b.textContent = mattOverlayStyle === "only" ? "叠底图" : "只看蒙版";
  }
  else if (a === "strokeundo") { $("mattUndo").click(); }
  else if (a === "desel") { deselectAll(); }
  else if (a === "cancel") { draftCancel(); }                    // 统一出口：取消（§2.5.1）
  else if (a === "confirm") { draftConfirm(); }                  // 统一出口：确认
});
/* 编辑条统一结构：左侧操作说明 + 模式专用按钮，右侧固定「取消 / 确认」。
   v1.2 只有裁剪有确认、其余三个模式只有「完成」且改动即时生效 ——
   这正是「没有出口的编辑态」，需求 §2.5.1 规则 1（进入必有出口）针对的就是它。 */
function buildEditBar() {
  editbar.style.display = "flex";
  if (refine.mode === "crop") { updateCropInfo(); return; }
  if (refine.mode === "matt") {
    editbar.innerHTML =
      '<span>左键涂绿=保留，右键涂红=扣除</span>' +
      '<span class="sep"></span>' +
      '<button data-a="fit">适应</button>' +
      '<button data-a="maskonly">只看蒙版</button>' +
      '<button data-a="strokeundo">撤销一笔</button>' +
      '<span class="sep"></span>' +
      '<button data-a="cancel">取消</button>' +
      '<button data-a="confirm" class="solid">确认</button>';
    return;
  }
  if (refine.mode === "edit") {
    const n = refine.sel ? refine.sel.reduce(function (a, b) { return a + b; }, 0) : 0;
    editbar.innerHTML =
      '<span>单击选中/再点取消 · 拖拽框选 · Shift 加选</span>' +
      '<span class="sep"></span>' +
      '<span class="mm">已选 ' + n + ' 格</span>' +
      '<button data-a="desel">取消选中</button>' +
      '<span class="sep"></span>' +
      '<button data-a="cancel">取消</button>' +
      '<button data-a="confirm" class="solid">确认</button>';
    return;
  }
  if (refine.mode === "edge") {
    editbar.innerHTML =
      '<span>选包边色，预览即时更新（确认后生效）</span>' +
      '<span class="sep"></span>' +
      '<button data-a="cancel">取消</button>' +
      '<button data-a="confirm" class="solid">确认</button>';
  }
}
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("resetAll").addEventListener("click", function () {
  if (!confirm("重置会丢弃全部手动修改（逐格改色 / 包边 / 裁剪），恢复到本次转换的初始图纸。\n\n上传的图片与参数配置不受影响。要继续吗？")) return;
  draftReset();                    // 未确认的编辑一并丢弃
  const oldRect = workRect();
  refine.manual = null; refine._manualT = 0;
  refine.edge = EMPTY;
  refine.crop = null; refine.cropPendingCrop = null;
  refine.sel = null;
  // 蒙版算「抠图结果」而非「手动修改」（Story 7.2 说的是丢弃手动修改），重置保留它；
  // 但裁剪被清了，工作区变了，蒙版必须重映射到「整幅居中方裁」，否则又错位
  if (refine.mask) remapMaskToRect(oldRect, workRect());
  masterSig = "";
  pushHistory(state.target);
  updateEdgeSwatch(); updateInfo(); updateFxSum();
  if (refine.mode === "crop") syncCropUI();
  run();
  toast("已重置为本次转换的初始图纸", "ok");
});


/* ---------- 5.3 导出 ----------
   非破坏性：整张图纸按「每格 40px」重画一遍，而不是直接把预览画布 toBlob。
   原因有两个：
     1. 预览画布宽度受侧栏可用宽度限制，直接导出会得到一张比承诺规格小的图；
     2. 预览画布的 cells 是「预览档位」的网格，导出必须显式声明自己的档位与每格像素，
        否则改一档参数就会让导出结果跟着变，不可预期。
   精修成果（包边层、逐格改色、空格）都会一起带过去——因为它们描述的是格子内容，
   与「画多少像素」无关。 */
const EXPORT_CELL = 40;          // 方案 Q14：每格 40px
$("save").addEventListener("click", function () {
  if (!lastResult || running) return;
  const btn = this, label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "导出中…";

  const t = lastResult.target;
  const off = workingCanvas(1, 1);
  const octx = off.getContext("2d");
  const meta = render(lastResult.cells, t, lastResult.layer, null, octx, {
    cell: EXPORT_CELL,
    cardCols: 12
  });

  const done = function (blob) {
    btn.disabled = false;
    btn.textContent = label;
    if (!blob) { toast("导出失败，换个浏览器再试", "err"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = (imageName || "pattern").replace(/\.[^.]+$/, "") || "pattern";
    a.download = base + "_" + t + "x" + t + "_" + meta.used.length + "色_MARD221.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast("PNG 已保存（" + meta.W + "×" + meta.H + " px，每格 " + EXPORT_CELL + "px）", "ok");
  };
  if (off.convertToBlob) off.convertToBlob({ type: "image/png" }).then(done);
  else off.toBlob(done, "image/png");
});

