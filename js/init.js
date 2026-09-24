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

/* ---------- 5.6 P2 智能转换占位（需求 E8 界面展位，后端未实现） ----------
   只做单选交互与「未开放」提示，不触碰转换链路 —— Story 8.1 要求未选风格时
   走原有链路、智能转换不影响基础功能。风格内置提示词属于后端契约，前端不暴露。 */
(function () {
  const box = $("p2styles"), runBtn = $("p2run");
  if (!box || !runBtn) return;
  let picked = null;
  box.addEventListener("click", function (e) {
    const b = e.target.closest("button"); if (!b) return;
    const name = b.querySelector("b") ? b.querySelector("b").textContent : "该风格";
    if (b.classList.contains("on")) {              // 再点一次 = 取消选择（单选可逆）
      b.classList.remove("on");
      picked = null;
      runBtn.textContent = "生成风格图";
      return;
    }
    Array.prototype.forEach.call(box.children, function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    picked = { key: b.dataset.s, name: name };
    runBtn.textContent = "生成「" + name + "」风格图";
  });
  runBtn.addEventListener("click", function () {
    if (!picked) { toast("先在上方选一个风格（不选则直接用原图转换）"); return; }
    if (!imageData) { nudge("先上传一张图片，再生成风格图"); return; }
    /* P2 后端（模型代理）未实现：明确告知但不阻塞、不影响其它功能（Story 8.2 的失败语义） */
    toast("「" + picked.name + "」风格化生成将在 P2 上线，当前请直接上传原图转换", "info");
  });
})();

