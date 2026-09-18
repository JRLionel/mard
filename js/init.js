"use strict";
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

/* ---------- 5.5 初始化 ---------- */
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

