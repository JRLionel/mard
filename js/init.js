"use strict";
/* ============================================================
   初始化入口

   本文件只做「装配」：视口监听 + 核心控件初始化 + 各 P2 模块的 init 调用。
   业务逻辑一律在各功能模块里（P1 精修见 refine-*.js，P2 见 p2-*.js）。
   ============================================================ */

/* ---------- 5.4 视口变化 ---------- */
let zoomTimer = null;
window.addEventListener("resize", function () {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(function () {
    applyZoom();
    if (refine.mode === "crop" || refine.mode === "matt") {
      fitView(); renderEditOverlay(); drawCropBox();
    }
  }, 160);
});

/* ---------- 5.5 核心控件初始化 ---------- */
fillRange($("ncolors"));
fillRange($("thr"));
updateSizeHint();
updateInfo();
updateEdgeSwatch();
updateHistUI();
updateFxGates();
const pool0 = suppressNearDuplicates(PALETTE, state.thr).length;
$("poolsz").textContent = pool0;
$("advsum").textContent = state.thr.toFixed(3) + " → 可用 " + pool0 + " 色";

/* ---------- 5.6 P2 模块装配（需求 E8） ----------
   缺文件时优雅降级：只把 P2 区域标为不可用，P0/P1 全部功能不受影响。
   这与「抠图服务连不上时其余功能照常可用」是同一条红线。 */
(function () {
  const host = $("pmHost");
  if (host) host.textContent = CUTOUT_URL.replace(/^https?:\/\//, "");

  let ok = true;
  if (window.P2Style && typeof P2Style.init === "function") P2Style.init();
  else ok = false;
  if (window.P2Compare && typeof P2Compare.init === "function") P2Compare.init();
  else ok = false;

  if (!ok) {
    const hint = $("p2hint");
    if (hint) hint.textContent = "智能转换模块未加载，暂不可用。上传 / 转换 / 精修 / 导出全部不受影响。";
    const runBtn = $("p2run");
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = "智能转换暂不可用"; }
  }
})();
