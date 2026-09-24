"use strict";
/* ============================================================
   P2 智能转换 · 风格化生成（需求 E8 / Story 8.1-8.3）

   ★ 输入源会话模型（本模块的核心设计）
   原图与风格图各自持有一整套独立状态（imageData / 精修层 / 历史栈 / 图纸结果）。
   全局变量永远保存「当前活跃会话」，非活跃会话以快照形式放在 sessions 里。
   因此切换输入源只是「把快照装回全局」，不复制像素、不破坏任何坐标系：
   workRect / 蒙版 _maskRect / crop / manual / hist 全部锚定各自的原图，互不干扰。
   —— Story 8.2「风格化仅作为可选输入源，不覆盖原图」的最强实现：
      回退到原图时，用户在原图上做过的裁剪/抠图/包边/改色/历史全部原样恢复。

   另外两处工程要点：
   - 代次守卫（token）：生成是 60 秒级长异步，落地前核对代次，期间换图/切会话
     则丢弃旧响应（与 run() 的 runToken 同一思路，Story 3.2）。
   - 复用抠图链路的 CUTOUT_URL 与 fetchWithTimeout：file:// 下相对路径会指向
     本地文件系统而必然失败，服务地址必须显式指向本机（见 refine-cutout.js）。
   ============================================================ */
window.P2Style = (function () {

  const KEY_ORIGINAL = "original", KEY_STYLE = "style";

  /* 非活跃会话的快照。sessions[active] 恒为 null —— 活跃会话就在全局变量里。 */
  let sessions = { original: null, style: null };
  let active = KEY_ORIGINAL;

  let picked = null;          // 当前选中的风格 {key, name}
  let styleInfo = null;       // 最近一次生成的风格图 {url, imageData, name, styleName, w, h, dw, dh, ms}
  let running = false;        // 生成中（防重复触发）
  let token = 0;              // 代次守卫
  let consented = false;      // 本页面会话是否已同意上传

  /* ---------- 会话快照 / 装载 ---------- */
  function blankRefine() {
    return {
      crop: null, cropPendingCrop: null,
      mask: null, _maskRect: null,
      edge: EMPTY, manual: null, _manualT: 0, sel: null
    };
  }
  function capture() {
    return {
      imageData: imageData, imageName: imageName, imageWH: imageWH, imageURL: imageURL,
      master: master, masterOk: masterOk, masterW: masterW, masterSig: masterSig,
      lastResult: lastResult, lastConsist: lastConsist, lastPoolLen: lastPoolLen,
      hist: hist.slice(), histPos: histPos, everRan: everRan,
      // 该会话图纸生成时的参数快照（对比视图判「参数已变化」的依据）。
      // 不能用 lastResult.meta 里的字段：render 的 meta 不含色数，只有自评钩子才有。
      params: { target: state.target, N: state.N },
      refine: {
        crop: refine.crop, mask: refine.mask, _maskRect: refine._maskRect,
        edge: refine.edge, manual: refine.manual, _manualT: refine._manualT, sel: refine.sel
      }
    };
  }
  function apply(s) {
    imageData = s.imageData; imageName = s.imageName; imageWH = s.imageWH; imageURL = s.imageURL;
    master = s.master; masterOk = s.masterOk; masterW = s.masterW; masterSig = s.masterSig;
    lastResult = s.lastResult; lastConsist = s.lastConsist; lastPoolLen = s.lastPoolLen;
    hist = s.hist.slice(); histPos = s.histPos; everRan = s.everRan;
    const r = s.refine;
    refine.crop = r.crop; refine.cropPendingCrop = null;
    refine.mask = r.mask; refine._maskRect = r._maskRect;
    refine.edge = r.edge; refine.manual = r.manual; refine._manualT = r._manualT;
    refine.sel = r.sel;
    draftReset();
  }
  function freshStyleSession() {
    const d = styleInfo.imageData;
    return {
      imageData: d, imageName: styleInfo.name, imageWH: [d.width, d.height], imageURL: styleInfo.url,
      master: null, masterOk: null, masterW: null, masterSig: "",
      lastResult: null, lastConsist: null, lastPoolLen: 0,
      hist: [], histPos: -1, everRan: false,
      refine: blankRefine()
    };
  }

  /* ---------- 编辑态守卫（需求 §2.5.2 A：切走前必须提示） ----------
     风格化「生成」只是取数预览，不碰精修层 → 不打断编辑态；
     「切换输入源」会冻结当前会话，必须先处理未确认的改动。 */
  function draftPending() { return !!(draft.kind && draftChanged()); }
  function discardDraftQuiet() {
    if (!draft.kind) return;
    if (draft.kind !== "crop" && draft.base) {
      for (const k of draftFields(draft.kind)) refine[k] = draft.base[k];
    }
    if (draft.kind === "crop") refine.cropPendingCrop = null;
    draftReset();
    masterSig = "";
    if (refine.mode !== "none") setMode("none", true);
  }
  function guardDraft(what) {
    if (!draftPending()) return true;
    const ok = confirm(
      "当前有尚未确认的精修改动。\n\n" + what +
      "会把它存档并切走另一套状态（两套互不影响，切回来仍是已确认的样子），" +
      "但这份未确认的改动会被放弃。\n\n要继续吗？（选「取消」留在当前编辑）"
    );
    if (!ok) toast("已留在当前编辑态", "info");
    return ok;
  }

  /* ---------- 会话切换 ---------- */
  function switchTo(target) {
    if (target === active) return true;
    discardDraftQuiet();
    sessions[active] = capture();
    const s = sessions[target];
    if (s) { apply(s); sessions[target] = null; }
    active = target;
    syncSourceUI();
    refreshUI();
    if (window.P2Compare && P2Compare.refresh) P2Compare.refresh();
    run();
    return true;
  }

  /* ---------- 对外：供对比视图读取两套图纸 ----------
     活跃会话的图纸永远与当前参数一致（改参数会就地重算），所以它的 params 取当前值；
     非活跃会话返回离开时记录的快照，供对比视图判断是否过期。 */
  function patterns() {
    const now = { target: state.target, N: state.N };
    const out = {};
    [KEY_ORIGINAL, KEY_STYLE].forEach(function (k) {
      let src;
      if (k === active) {
        out[k] = lastResult
          ? { lastResult: lastResult, imageName: imageName, styleName: null, params: now }
          : null;
        return;
      }
      src = sessions[k];
      const styleName = (k === KEY_STYLE && styleInfo) ? styleInfo.styleName : null;
      out[k] = (src && src.lastResult)
        ? { lastResult: src.lastResult, imageName: src.imageName, styleName: styleName, params: src.params || now }
        : null;
    });
    return out;
  }
  function activeKey() { return active; }
  function styleImage() { return styleInfo; }

  /* ---------- 隐私同意（需求 §3 安全要求 / 假设 9，G1：阻断级用模态） ---------- */
  function askConsent() {
    if (consented) return Promise.resolve(true);
    const modal = $("privacyModal");
    if (!modal) return Promise.resolve(true);          // 结构缺失时不拦路
    return new Promise(function (resolve) {
      modal.hidden = false;
      modal.classList.add("show");
      const done = function (ok) {
        modal.classList.remove("show");
        modal.hidden = true;
        $("pmOk").removeEventListener("click", onOk);
        $("pmCancel").removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey, true);
        if (ok) consented = true;
        resolve(ok);
      };
      const onOk = function () { done(true); };
      const onCancel = function () { done(false); };
      const onKey = function (e) { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
      $("pmOk").addEventListener("click", onOk);
      $("pmCancel").addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey, true);
    });
  }

  /* ---------- 进度 ---------- */
  function setProgress(pct, text) {
    const box = $("p2prog");
    if (!box) return;
    box.hidden = false;
    $("p2fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
    $("p2ptext").textContent = text;
  }
  function clearProgress() {
    const box = $("p2prog");
    if (box) box.hidden = true;
  }

  /* ---------- UI 同步 ---------- */
  function syncSourceUI() {
    const isStyle = active === KEY_STYLE;
    $("thumb").src = isStyle && styleInfo ? styleInfo.url : imageURL;
    $("fname").textContent = imageName;
    $("fname").title = imageName;
    $("fdim").textContent = imageWH[0] + " × " + imageWH[1] + " px";
    $("drop").classList.add("has-file");
    $("drop").classList.toggle("is-style", isStyle);
    const badge = $("srcBadge");
    if (badge) badge.hidden = !isStyle;
  }
  function refreshUI() {
    const hasImg = !!imageData;
    const runBtn = $("p2run");
    if (runBtn) {
      // G6：不用「禁用」代替引导 —— 有图就可点，未选风格时点下去给引导提示
      runBtn.disabled = running || !hasImg;
      runBtn.textContent = running ? "生成中…"
        : (picked ? "生成「" + picked.name + "」风格图" : "生成风格图");
    }
    const useBtn = $("p2use"), backBtn = $("p2back");
    if (useBtn) useBtn.disabled = !styleInfo || active === KEY_STYLE;
    if (backBtn) backBtn.disabled = !styleInfo || active === KEY_ORIGINAL;
    const sum = $("p2sum");
    if (sum) {
      sum.textContent = !styleInfo ? "未生成"
        : (active === KEY_STYLE ? "使用中 · " + styleInfo.styleName : "已生成 · " + styleInfo.styleName);
    }
  }
  function showPreview() {
    const box = $("p2preview");
    if (!box) return;
    box.hidden = false;
    $("p2thumb").src = styleInfo.url;
    $("p2badge").textContent = styleInfo.styleName;
    $("p2name").textContent = styleInfo.name;
    $("p2dim").textContent = styleInfo.w + " × " + styleInfo.h + " px";
  }

  /* ---------- 生成 ---------- */
  async function errorText(resp) {
    try {
      const j = await resp.json();
      if (j && j.error) return j.error;
    } catch (e) { /* 非 JSON 响应 */ }
    return "风格化服务返回 " + resp.status;
  }

  async function adopt(blob, msHeader) {
    const bmp = await createImageBitmap(blob);
    // ⚠️ 尺寸必须在 close() 之前取出：已关闭的 ImageBitmap 宽高归零
    const w = bmp.width, h = bmp.height;
    // 与上传路径一致：超大图预降采样（MAX_SRC），控制后续主网格遍历成本
    const side = Math.max(w, h);
    const k = side > MAX_SRC ? MAX_SRC / side : 1;
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
    const oc = workingCanvas(dw, dh);
    const octx = oc.getContext("2d", { willReadFrequently: true });
    octx.imageSmoothingQuality = "high";
    octx.drawImage(bmp, 0, 0, dw, dh);
    const data = octx.getImageData(0, 0, dw, dh);
    if (bmp.close) bmp.close();

    if (styleInfo && styleInfo.url) URL.revokeObjectURL(styleInfo.url);
    const base = (imageName || "style").replace(/\.[^.]+$/, "");
    styleInfo = {
      url: URL.createObjectURL(blob), imageData: data,
      name: base + "_" + picked.key + ".png", styleName: picked.name,
      w: w, h: h, dw: dw, dh: dh,
      ms: msHeader ? +msHeader : null
    };
    sessions.style = null;               // 新风格图 = 旧的风格会话作废

    if (active === KEY_STYLE) {          // 使用中重新生成 → 就地换成新会话并重算
      apply(freshStyleSession());
      run();
    }
    showPreview();
    refreshUI();
  }

  async function generate() {
    if (running) return;
    if (!imageData) { nudge("先上传一张图片，再生成风格图"); return; }
    if (!picked) { toast("先在上方选一个风格（不选则直接用原图转换）"); return; }

    const ok = await askConsent();
    if (!ok) { toast("已取消，未上传任何图片", "info"); return; }

    running = true;
    const myToken = ++token;             // ★ 代次守卫
    const srcAt = imageData;             // 发起时的输入源身份
    // 过期判定：期间重新发起过生成，或用户换了图 / 切了会话（都会换掉 imageData 对象）
    const stale = function () { return myToken !== token || imageData !== srcAt; };
    refreshUI();
    setProgress(8, "准备中：正在编码当前图片…");

    try {
      const blob = await fullImageBlob();          // 复用抠图的整图编码
      if (stale()) return;
      setProgress(30, "上传中：发往本机风格化服务…");

      const fd = new FormData();
      fd.append("file", blob, "source.png");
      fd.append("style", picked.key);

      const resp = await fetchWithTimeout(CUTOUT_URL + "/style-transfer",
        { method: "POST", body: fd }, 70000);
      if (stale()) return;
      if (!resp.ok) throw new Error(await errorText(resp));

      setProgress(70, "生成中：模型正在重绘（最长 60 秒）…");
      const outBlob = await resp.blob();
      if (stale()) return;

      setProgress(90, "下载中：取回生成结果…");
      await adopt(outBlob, resp.headers.get("X-Style-Ms"));
      if (stale()) return;

      setProgress(100, "完成");
      setStatus("风格图已生成 · 点「用风格图生成」以它重算图纸", "done");
      toast("「" + picked.name + "」风格图已生成" + (styleInfo.ms ? "（" + styleInfo.ms + " ms）" : ""), "ok");
      setTimeout(clearProgress, 900);

    } catch (err) {
      if (stale()) return;                         // 已被更新的一次生成取代 / 已换图
      const msg = (err && err.name === "AbortError")
        ? "风格化生成超时（超过 60 秒），请稍后重试"
        : (err && err.message ? err.message : "未知错误");
      setStatus("风格化生成失败：" + msg, "err");
      toast("生成失败：" + msg, "err");
      askStartStyleBackend(msg);
      clearProgress();
    } finally {
      if (myToken === token) { running = false; refreshUI(); }
    }
  }

  /* 服务连不上时给可执行的修复指引（与抠图链路的 askStartBackend 同款做法） */
  function askStartStyleBackend(msg) {
    if (/暂未开放|未配置/.test(msg)) return;
    const hint = $("p2hint");
    if (hint) hint.textContent = "连不上本机风格化服务（" + CUTOUT_URL + "）。后端未启动时，上传/转换/裁剪/包边/改色/导出全部照常可用。";
  }

  /* ---------- 切换 / 回退 ---------- */
  function useStyle() {
    if (!styleInfo || running) return;
    if (active === KEY_STYLE) return;
    if (!guardDraft("切换到风格图")) return;
    ensureStyleSession();
    if (!switchTo(KEY_STYLE)) return;
    setStatus("已切换到风格图输入源 · 走完整链路重算图纸", "done");
    toast("已用「" + styleInfo.styleName + "」风格图作为输入源", "ok");
  }
  function backToOriginal() {
    if (!styleInfo || running) return;
    if (active === KEY_ORIGINAL) return;
    if (!guardDraft("回到原图")) return;
    if (!switchTo(KEY_ORIGINAL)) return;
    setStatus("已回退到原图，精修成果原样恢复", "done");
    toast("已回退到原图", "ok");
  }
  function ensureStyleSession() {
    if (!sessions[KEY_STYLE]) sessions[KEY_STYLE] = freshStyleSession();
  }

  /* ---------- 风格选择 ---------- */
  function bindStyles() {
    const box = $("p2styles");
    if (!box) return;
    box.addEventListener("click", function (e) {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      const name = b.querySelector("b") ? b.querySelector("b").textContent : "该风格";
      if (b.classList.contains("on")) {              // 再点一次 = 取消（单选可逆）
        b.classList.remove("on");
        b.setAttribute("aria-pressed", "false");
        picked = null;
        refreshUI();
        return;
      }
      Array.prototype.forEach.call(box.children, function (x) {
        x.classList.remove("on");
        x.setAttribute("aria-pressed", "false");
      });
      b.classList.add("on");
      b.setAttribute("aria-pressed", "true");
      picked = { key: b.dataset.s, name: name };
      refreshUI();
    });
  }

  function init() {
    bindStyles();
    const runBtn = $("p2run"), useBtn = $("p2use"), backBtn = $("p2back");
    if (runBtn) runBtn.addEventListener("click", generate);
    if (useBtn) useBtn.addEventListener("click", useStyle);
    if (backBtn) backBtn.addEventListener("click", backToOriginal);
    // 上传区换图后同步按钮可用性（loadFile 在 state.js 里，不为 P2 加钩子：
    // 盯缩略图 src 变化即可，loadFile 每次载入都会写它）
    const thumb = $("thumb");
    if (thumb && typeof MutationObserver === "function") {
      new MutationObserver(function () { refreshUI(); })
        .observe(thumb, { attributes: true, attributeFilter: ["src"] });
    }
    refreshUI();
  }

  return {
    init: init,
    patterns: patterns,
    activeKey: activeKey,
    styleImage: styleImage,
    refreshUI: refreshUI,
    hasStyleDetail: function () { return !!styleInfo; },
    styleSessionReady: function () {
      return !!(styleInfo && (active === KEY_STYLE || (sessions[KEY_STYLE] && sessions[KEY_STYLE].lastResult)));
    }
  };
})();
