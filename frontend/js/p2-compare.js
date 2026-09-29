"use strict";
/* ============================================================
   P2 对比视图（Story 8.3 的延伸）

   把两个输入源会话各自的图纸并排看：原图图纸 | 风格化图纸。
   - 面板用与预览完全相同的每格像素（CELL=40）渲染，再交给 CSS 按面板宽度缩放
     —— 保证与单视图/导出的像素表现逐比特一致（不用小 cell 规避 S<0.5 的
     空格绘制分支，那会把斜纹底换成纯浅灰）。
   - 参数一致性：规格 / 色数变了以后，当前活跃会话的图纸会实时重算（面板跟着刷新），
     非活跃会话的图纸保持缓存并就地标记「参数已变化」，不自动重算（设计 D5）。
   - 刷新时机用 MutationObserver 盯 #cv 的 width/height 变化（render 每次都会写），
     不需要在 state.js 里为 P2 加钩子。
   ============================================================ */
window.P2Compare = (function () {

  let mode = "single";
  let observer = null;
  let refreshTimer = null;

  function panels() {
    return window.P2Style ? P2Style.patterns() : { original: null, style: null };
  }
  function hasBoth() {
    const p = panels();
    return !!(p.original && p.style);
  }

  /* ---------- 模式切换 ---------- */
  function setMode(next, quiet) {
    if (next === "compare" && !hasBoth()) {
      explainMissing(quiet);
      return false;
    }
    mode = next;
    const stage = $("stage"), cmp = $("compare");
    if (stage) stage.hidden = (next === "compare");
    if (cmp) cmp.hidden = (next !== "compare");
    const box = $("viewmodes");
    if (box) {
      Array.prototype.forEach.call(box.children, function (b) {
        const on = b.dataset.view === next;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    if (next === "compare") {
      clearTip();
      renderPanels();
      applyZoom();                 // 单视图的画布尺寸提示同步收一下
    }
    return true;
  }

  function explainMissing(quiet) {
    const p = panels();
    const msg = !p.original && !p.style
      ? "先生成图纸，再用对比视图"
      : (!p.style
        ? (window.P2Style && P2Style.hasStyleDetail()
          ? "先在「智能转换」里点「用风格图生成」，产出风格化图纸后再对比"
          : "先生成一张风格化图纸，才能和原图对比")
        : "先生成原图图纸，才能和风格化图纸对比");
    setTip(msg);
    if (!quiet) toast(msg, "info");
  }

  /* ---------- 面板渲染 ---------- */
  function renderPanels() {
    const p = panels();
    paintPanel("A", p.original);
    paintPanel("B", p.style);
    markStale("A", p.original);
    markStale("B", p.style);
    updatePanelTitle("A", "原图图纸", p.original);
    updatePanelTitle("B", "风格化图纸", p.style);
  }

  function updatePanelTitle(letter, fallback, pat) {
    const el = $("cmpTitle" + letter);
    if (!el) return;
    el.textContent = fallback;
    el.title = pat && pat.imageName ? pat.imageName : "";
  }

  function paintPanel(letter, pat) {
    const cv = $("cmpCv" + letter);
    if (!cv) return;
    const c2 = cv.getContext("2d");
    if (!pat) {
      cv.width = 640; cv.height = 240;
      c2.fillStyle = "#FBFAF7";
      c2.fillRect(0, 0, cv.width, cv.height);
      c2.fillStyle = "#8A837C";
      c2.font = "13px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
      c2.textAlign = "center";
      c2.textBaseline = "middle";
      c2.fillText("尚未生成该输入源的图纸", cv.width / 2, cv.height / 2);
      cv.style.width = "100%";
      cv.style.height = "auto";
      return;
    }
    const lr = pat.lastResult;
    render(lr.cells, lr.target, lr.layer, null, c2, { cell: CELL, cardCols: 10 });
    cv.style.width = "100%";
    cv.style.height = "auto";
  }

  /* 非活跃会话的图纸参数与当前参数不一致 → 就地标记（设计 D5 / spec 参数一致性）
     依据是 patterns() 给的 params 快照（离开该会话时记下的规格 + 色数）；
     活跃会话的 params 恒等于当前值，因此永远不判过期（它改参数时会就地重算）。 */
  function staleDiff(pat) {
    if (!pat || !pat.params) return null;
    const d = [];
    if (pat.params.target !== state.target) {
      d.push(pat.params.target + "×" + pat.params.target + " → " + state.target + "×" + state.target);
    }
    if (pat.params.N !== state.N) {
      d.push("最多 " + pat.params.N + " 色 → " + state.N + " 色");
    }
    return d.length ? d : null;
  }
  function markStale(letter, pat) {
    const el = $("cmpStale" + letter);
    if (!el) return;
    const d = staleDiff(pat);
    el.hidden = !d;
    if (d) el.textContent = "参数已变化（" + d.join("，") + "）· 切回该视图会重算";
  }

  /* ---------- 同步滚动 ---------- */
  function onScroll(letter) {
    if (mode !== "compare") return;
    const sync = $("cmpSync");
    if (!sync || !sync.checked) return;
    const src = $("cmpScroll" + letter);
    const dst = $("cmpScroll" + (letter === "A" ? "B" : "A"));
    if (!src || !dst) return;
    // 目标已同步则不动 —— 避免两面板互相触发的回环
    if (Math.abs(dst.scrollTop - src.scrollTop) < 1 &&
      Math.abs(dst.scrollLeft - src.scrollLeft) < 1) return;
    dst.scrollTop = src.scrollTop;
    dst.scrollLeft = src.scrollLeft;
  }

  /* ---------- 导出并排对比图 ---------- */
  function offSheet(pat) {
    const off = workingCanvas(1, 1);
    const o2 = off.getContext("2d");
    const lr = pat.lastResult;
    const meta = render(lr.cells, lr.target, lr.layer, null, o2,
      { cell: EXPORT_CELL, cardCols: 12 });
    return { canvas: off, meta: meta, target: lr.target };
  }

  function exportCompare() {
    const p = panels();
    if (!p.original || !p.style) { explainMissing(); return; }
    const btn = $("cmpExport"), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "导出中…";

    const A = offSheet(p.original), B = offSheet(p.style);
    const pad = 40, gap = 40, band = 64;
    const W = pad * 2 + A.canvas.width + gap + B.canvas.width;
    const H = pad * 2 + band + Math.max(A.canvas.height, B.canvas.height);

    const comp = document.createElement("canvas");
    comp.width = W; comp.height = H;
    const cx = comp.getContext("2d");
    cx.fillStyle = "#FFFFFF";
    cx.fillRect(0, 0, W, H);

    const font = "600 26px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    cx.fillStyle = "#2E2A27";
    cx.font = font;
    cx.textAlign = "left";
    cx.textBaseline = "alphabetic";
    cx.fillText("原图图纸" + suffix(A), pad, pad + 30);
    cx.fillText("风格化图纸" + suffix(B), pad + A.canvas.width + gap, pad + 30);

    cx.drawImage(A.canvas, pad, pad + band);
    cx.drawImage(B.canvas, pad + A.canvas.width + gap, pad + band);

    const done = function (blob) {
      btn.disabled = false;
      btn.textContent = label;
      if (!blob) { toast("导出失败，换个浏览器再试", "err"); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "compare_原图_vs_风格图_" + A.target + "x" + A.target + ".png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast("对比图已保存（" + W + "×" + H + " px）", "ok");
    };
    if (comp.toBlob) comp.toBlob(done, "image/png");
    else done(null);
  }
  function suffix(sheet) {
    const used = sheet.meta && sheet.meta.used ? sheet.meta.used.length : "?";
    return "   " + sheet.target + "×" + sheet.target + " · " + used + " 色";
  }

  /* ---------- 提示行 ---------- */
  function setTip(msg) { const el = $("cmpTip"); if (el) el.textContent = msg; }
  function clearTip() { setTip(""); }

  /* ---------- 刷新（会话切换 / 图纸重算后） ---------- */
  function refresh() {
    if (mode !== "compare") return;
    renderPanels();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 60);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    const box = $("viewmodes");
    if (box) {
      box.addEventListener("click", function (e) {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.view === "single") setMode("single");
        else setMode("compare");
      });
    }
    ["A", "B"].forEach(function (L) {
      const el = $("cmpScroll" + L);
      if (el) el.addEventListener("scroll", function () { onScroll(L); }, { passive: true });
    });
    const ex = $("cmpExport");
    if (ex) ex.addEventListener("click", exportCompare);
    const sync = $("cmpSync");
    if (sync) sync.addEventListener("change", function () {
      if (this.checked) { onScroll("A"); } else { setTip(""); }
    });

    // 图纸重算（render 会改 #cv 的 width/height）→ 对比面板跟着刷新
    const cvEl = $("cv");
    if (cvEl && typeof MutationObserver === "function") {
      observer = new MutationObserver(function () { scheduleRefresh(); });
      observer.observe(cvEl, { attributes: true, attributeFilter: ["width", "height"] });
    }
    setMode("single", true);
  }

  return { init: init, refresh: refresh, setMode: setMode, isCompare: function () { return mode === "compare"; } };
})();
