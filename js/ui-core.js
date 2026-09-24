"use strict";
/* ---------- 5.1 上传：点击 / 拖拽 / 粘贴 ---------- */
function pickFile() { $("file").click(); }

$("drop").addEventListener("click", pickFile);
$("drop").addEventListener("keydown", function (e) {
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); pickFile(); }
});
$("file").addEventListener("change", function (e) {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
  e.target.value = "";                      // 允许重复选择同一个文件
});

["dragenter", "dragover"].forEach(function (t) {
  $("drop").addEventListener(t, function (e) {
    e.preventDefault(); e.stopPropagation();
    $("drop").classList.add("is-over");
  });
});
["dragleave", "drop"].forEach(function (t) {
  $("drop").addEventListener(t, function (e) {
    e.preventDefault(); e.stopPropagation();
    $("drop").classList.remove("is-over");
  });
});
$("drop").addEventListener("drop", function (e) {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

/* 拖到窗口任意位置都能接住 */
let dragDepth = 0;
function hasFiles(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  if (!t) return false;
  for (let i = 0; i < t.length; i++) if (t[i] === "Files") return true;
  return false;
}
window.addEventListener("dragenter", function (e) {
  if (!hasFiles(e)) return;
  dragDepth++;
  $("veil").classList.add("show");
});
window.addEventListener("dragover", function (e) { e.preventDefault(); });
window.addEventListener("dragleave", function () {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("veil").classList.remove("show");
});
window.addEventListener("drop", function (e) {
  e.preventDefault();
  dragDepth = 0;
  $("veil").classList.remove("show");
  $("drop").classList.remove("is-over");
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

/* 粘贴 */
window.addEventListener("paste", function (e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf("image") === 0) {
      const f = items[i].getAsFile();
      if (f) { loadFile(f); toast("已从剪贴板读取图片", "ok"); }
      break;
    }
  }
});

/* ---------- 5.2 参数控件 ---------- */
function markOn(box, btn) {
  Array.prototype.forEach.call(box.children, function (x) {
    x.classList.remove("on");
    if (x.setAttribute) x.setAttribute("aria-pressed", "false");
  });
  btn.classList.add("on");
  btn.setAttribute("aria-pressed", "true");
}

function updateInfo() {
  const spec = state.target + "×" + state.target + " 网格 · 最多 " + state.N + " 色";
  if (!imageData) { $("info").textContent = "尚未上传图片 · 当前规格 " + spec; return; }
  const bits = [];
  if (refine.crop) bits.push("已裁剪 " + refine.crop.w + "×" + refine.crop.h);
  if (refine.mask) bits.push("已抠图");
  if (refine.edge !== EMPTY) bits.push("包边 " + PALETTE[refine.edge].code);
  const manualN = countManual();
  if (manualN) bits.push("手动改 " + manualN + " 格");
  $("info").textContent = imageName + " · " + imageWH[0] + "×" + imageWH[1] + " px · " + spec +
    (bits.length ? " · " + bits.join(" · ") : "");
}
function countManual() {
  if (!refine.manual) return 0;
  let n = 0;
  for (let i = 0; i < refine.manual.length; i++) if (refine.manual[i] !== EMPTY) n++;
  return n;
}

$("grids").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  const n = +b.dataset.n;
  if (n === state.target) return;
  if (!invalidateRefine("网格规格")) return;
  markOn(this, b);
  state.target = n;
  updateSizeHint();
  updateInfo();
  if (imageData) run();
});


/* ⚠️ 这里曾有一段「无守卫的 presets click 监听」与下方带守卫的监听并存：
   无守卫的先注册先执行，state.N 已被改掉、run() 已跑，用户即使在后面的
   confirm 里点「取消」，参数也回不来了 —— 守卫被完全架空。
   修法：只保留带守卫的那一个（见下方）。 */
/* 参数滑杆的丢弃守卫：必须在**值变化前**拦（pointerdown 拦拖动、input 拦键盘），
   事后确认是无效的 —— 防抖 run 早已把新参数算进去了，用户点「取消」参数也回不来。
   曾只绑 pointerdown：键盘方向键改值不触发它，已有精修成果会被静默丢弃（违反 G2）。
   _ok 是「本次手势已确认过」的记号：pointerdown / 键盘导航键把它重置，
   一段手势里只问一次；键盘手势之间各自独立。 */
function guardSlider(id, name, revert) {
  const el = $(id);
  el._ok = null;
  el.addEventListener("pointerdown", function (e) {
    el._ok = null;
    if (!imageData || !refineDirty()) return;
    if (invalidateRefine(name)) el._ok = true;
    else { el._ok = false; e.preventDefault(); }     // 拒绝：滑杆拖不动
  });
  el.addEventListener("keydown", function (e) {
    if (/^(Arrow|Home|End|Page)/.test(e.key)) el._ok = null;
  });
  return function () {                 // input 事件开头调用；false = 本次改动被拒、已回退
    if (el._ok === false) { revert(el); return false; }
    if (el._ok !== true && imageData && refineDirty()) {
      if (!invalidateRefine(name)) { el._ok = false; revert(el); return false; }
      el._ok = true;
    }
    return true;
  };
}
const ncolorsGuard = guardSlider("ncolors", "色数", function (el) { el.value = state.N; fillRange(el); });
const thrGuard = guardSlider("thr", "色号间距", function (el) { el.value = Math.round(state.thr * 1000); fillRange(el); });

let nTimer = null;
$("ncolors").addEventListener("input", function () {
  if (!ncolorsGuard()) return;
  const n = +this.value;
  state.N = n;
  $("nval").textContent = n;
  fillRange(this);
  Array.prototype.forEach.call($("presets").children, function (x) {
    x.classList.remove("on");
    x.setAttribute("aria-pressed", "false");
  });
  updateInfo();
  clearTimeout(nTimer);
  // Story 3.2：防抖 260ms，避免拖动过程中每一帧都触发一次完整重算；
  // 真正的时间正确性由 run() 里的 runToken 代次守卫保证（旧结果一律丢弃）
  if (imageData) nTimer = setTimeout(run, 260);
});

$("presets").addEventListener("click", function (e) {
  const b = e.target.closest("button"); if (!b) return;
  if (+b.dataset.n === state.N) return;
  if (!confirmDiscardOnParam()) return;
  markOn(this, b);
  state.N = +b.dataset.n;
  $("ncolors").value = state.N;
  fillRange($("ncolors"));
  $("nval").textContent = state.N;
  updateInfo();
  if (imageData) run();
});

/* 参数确认闸门：有精修成果时先问一次，避免用户白做 */
function confirmDiscardOnParam() {
  if (!invalidateRefine("色数")) { return false; }
  return true;
}

let tTimer = null;
$("thr").addEventListener("input", function () {
  if (!thrGuard()) return;
  state.thr = +this.value / 1000;
  $("thrval").textContent = state.thr.toFixed(3);
  fillRange(this);
  const pool = suppressNearDuplicates(PALETTE, state.thr).length;
  $("poolsz").textContent = pool;
  $("advsum").textContent = state.thr.toFixed(3) + " → 可用 " + pool + " 色";
  clearTimeout(tTimer);
  if (imageData) tTimer = setTimeout(run, 300);
});

$("run").addEventListener("click", run);

/* ============================================================
   6. P1 精修：裁剪 / 抠图 / 包边 / 改色
   ============================================================ */
const editwrap = $("editwrap"), editimg = $("editimg"), editov = $("editov");
const ectx = editov.getContext("2d");
const cropbox = $("cropbox");
const editbar = $("editbar");

/* 精修视口（editwrap）的视图变换：scale + 平移。
   所有交互都换算到「图片坐标」，这样裁剪框与蒙版在缩放/平移下始终对齐。 */
const view = { s: 1, tx: 0, ty: 0, fit: 1, ox: 0, oy: 0, iw: 1, ih: 1 };

function updateFxGates() {
  const has = !!imageData;
  const generated = !!lastResult;
  Array.prototype.forEach.call($("tools").children, function (b) {
    const t = b.dataset.tool;
    // 裁剪与抠图只需有原图；包边与改色需要有图纸（它们作用在网格上）
    b.disabled = !has || ((t === "edge" || t === "edit") && !generated);
  });
  $("cropApply").disabled = !refine.cropPendingCrop;
  $("fxhint").textContent = !has
    ? "上传图片后，「生成图纸」产出初版，再上来精修。"
    : (!generated ? "先点下方「生成图纸」，再回来做包边与改色。"
      : "在右侧预览上操作。图上方的工具条带「撤销 / 重置 / 完成」。");
  updateFxSum();
}
function updateFxSum() {
  const bits = [];
  if (refine.crop) bits.push("裁剪");
  if (refine.mask) bits.push("抠图");
  if (refine.edge !== EMPTY) bits.push("包边");
  const n = countManual();
  if (n) bits.push("改 " + n + " 格");
  $("fxsum").textContent = bits.length ? bits.join(" · ") : "未启用";
}
