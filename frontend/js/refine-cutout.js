"use strict";
/* ---------- 6.4 E5 抠图 ---------- */
const CUTOUT_URL = (function () {
  // 后端地址可覆盖：换端口 / 换机器时改这一处即可（例如 window.MARD_CUTOUT = "http://192.168.1.9:8000"）
  if (window.MARD_CUTOUT) return window.MARD_CUTOUT;
  // file:// 打开时同源指向本地文件系统，必须显式指向本机服务
  return "http://127.0.0.1:8000";
})();

async function autoCutout() {
  if (!imageData) return;
  const btn = $("mattRun");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>抠图中…';
  setStatus("正在调用本机抠图服务…", "busy");
  $("ovtext").textContent = "正在自动抠图…";
  $("ov").classList.add("show");
  try {
    // 发送完整原图：引擎的边界种子语义建立在画幅边缘上（见 fullImageBlob 注释）；
    // 裁剪由蒙版映射阶段处理，不发裁剪块
    const blob = await fullImageBlob();
    const fd = new FormData();
    fd.append("file", blob, "crop.png");
    fd.append("long_edge", "1024");
    fd.append("feather", "1");
    const resp = await fetchWithTimeout(CUTOUT_URL + "/cutout", { method: "POST", body: fd }, 30000);
    if (!resp.ok) {
      let msg = "抠图服务返回 " + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) { }
      throw new Error(msg);
    }
    const buf = await resp.arrayBuffer();
    const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }));
    // 蒙版固定 MASK_N=312 分辨率、锚定当前工作区。
    // 后端返回的是「完整原图」的蒙版 —— 按工作区矩形裁出来再缩放，
    // 保证蒙版坐标 = 工作区归一化坐标（契约：前端负责映射，需求 §2.5.3）。
    const Rm = workRect();
    const mc = workingCanvas(MASK_N, MASK_N);
    mc.getContext("2d", { willReadFrequently: true }).drawImage(
      bmp, Rm.x, Rm.y, Rm.w, Rm.h, 0, 0, MASK_N, MASK_N);
    const md = mc.getContext("2d").getImageData(0, 0, MASK_N, MASK_N).data;
    const arr = new Uint8Array(MASK_N * MASK_N);
    let kept = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = md[i * 4] >= 96 ? 1 : 0;    // alpha 阈值：偏保守，宁多留不少留
      arr[i] = v; if (v) kept++;
    }
    if (bmp.close) bmp.close();
    if (!kept) {
      throw new Error("没有识别出主体 —— 这张图可能整幅都是背景色（试试先框选主体再抠）");
    }
    setMask(arr, workRect());
    masterSig = "";
    $("mattctl").hidden = false;
    // 蒙版已就位但属「未确认」：可继续笔刷修正，点「确认」才写历史（需求 §2.5.3）。
    // （此处曾引用已删除的局部变量 t，ReferenceError 被 catch 吞成「抠图失败」，
    //  run() 不执行、图纸停在抠图前 —— 教训：catch 只报 err.message 会把拼写级
    //  错误伪装成服务问题。）
    draft.strokes = [];
    updateFxSum(); updateInfo(); updateEdgeSwatch();
    await run();
    renderEditOverlay();      // ★ 蒙版刚变化，必须重绘红色标注 ——
                              // 否则标注停留在旧状态（实测：自动抠图完成后画面上一片红都看不到）
    setStatus("抠图完成，可继续用笔刷修正；点「确认」生效", "done");
    toast("已扣除背景，主体 " + Math.round(kept / arr.length * 100) + "% 区域保留", "ok");
    if (kept / arr.length > 0.92) {
      toast("背景占比很小，自动结果可能不理想——可用笔刷手动修正", "info");
    }
  } catch (err) {
    // 浏览器的网络异常文案（Failed to fetch / NetworkError / load failed）对用户毫无意义，
    // 统一换成人话；同时给出可执行的修复指引，而不是让用户对着英文猜。
    const raw = err && err.message ? err.message : "";
    const offline = /Failed to fetch|NetworkError|load failed|ERR_CONNECTION|net::/i.test(raw);
    const m = offline
      ? "连不上本机抠图服务（" + CUTOUT_URL + "）"
      : (err && err.name === "AbortError" ? "抠图超时（超过 30 秒）" : (raw || "未知错误"));
    // 需求 Story 5.1：自动结果不佳时「仍输出结果不阻塞流程，并提示可手动修正」
    setStatus("抠图失败：" + m, "err");
    toast(offline ? "连不上本机抠图服务，图纸与其它功能不受影响" : ("抠图没成功：" + m), "err");
    if (offline) askStartBackend();
  } finally {
    btn.disabled = false;
    btn.textContent = "自动抠图";
    $("ov").classList.remove("show");
    updateFxGates();
  }
}

function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms);
  return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(function () {
    clearTimeout(timer);
  });
}

/* 后端没起来时给出可执行的修复指引，而不是一句「失败了」 */
function askStartBackend() {
  toast("连不上本机抠图服务（127.0.0.1:8000）", "err");
  setTimeout(function () {
    const ok = confirm(
      "连不上本机抠图服务。\n\n" +
      "在项目目录下打开终端，执行：\n" +
      "    cd backend && python3 app.py\n\n" +
      "看到 “Uvicorn running on http://127.0.0.1:8000” 后回到这里重试即可。\n\n" +
      "（抠图是本工具唯一需要后端的环节；裁剪、包边、改色、导出全部在本地完成，离线可用。）\n\n" +
      "再试一次？"
    );
    if (ok) autoCutout();
  }, 300);
}

/* 把当前裁剪区导出成 Blob，供后端处理 */
function fullImageBlob() {
  /* 发给后端的是**完整原图**，而不是工作区裁剪块。
     原因（实测）：抠图引擎的「边界种子」语义建立在画幅边缘上 —— 裁剪会把
     图片自身的细边框（本例左右只有 ~4px 的奶油框）切掉，边界环变成两种颜色，
     单一背景色洪水直接失效（蒙版全保留）。整幅发给引擎，返回的蒙版再由前端
     裁到工作区（见 autoCutout），坐标契约不破（需求 §2.5.3）。 */
  return new Promise(function (resolve) {
    const iw = imageData.width, ih = imageData.height;
    const mc = workingCanvas(iw, ih);
    mc.getContext("2d").putImageData(imageData, 0, 0);
    if (mc.convertToBlob) mc.convertToBlob({ type: "image/png" }).then(resolve);
    else mc.toBlob(resolve, "image/png");
  });
}

$("mattRun").addEventListener("click", autoCutout);
/* 「撤销一笔」是会话内操作（draft.strokes），不碰全局历史 ——
   全局历史只在「确认」时写入一次（需求 §2.5.5 的会话粒度同样适用于抠图） */
$("mattUndo").addEventListener("click", function () {
  if (!draft.strokes.length) { toast("没有可撤销的笔划"); return; }
  refine.mask = draft.strokes.pop();
  masterSig = "";
  renderEditOverlay();
  run();
  toast("已撤销上一笔", "ok");
});
$("mattInvert").addEventListener("click", function () {
  if (!refine.mask) return;
  const inv = new Uint8Array(refine.mask.length);
  let kept = 0;
  for (let i = 0; i < inv.length; i++) { inv[i] = refine.mask[i] ? 0 : 1; if (inv[i]) kept++; }
  if (!kept) { toast("反选后什么都不剩了，已忽略", "err"); return; }
  draft.strokes.push(refine.mask.slice());   // 反选也算一笔，可被「撤销一笔」回退
  setMask(inv, refine._maskRect);
  masterSig = "";
  updateFxSum(); updateInfo();
  run();
  toast("已反选蒙版", "ok");
});
$("mattClear").addEventListener("click", function () {
  if (!refine.mask) { toast("当前没有抠图蒙版"); return; }
  clearMask();
  masterSig = "";
  draft.strokes = [];
  $("mattctl").hidden = true;
  pushHistory(state.target);      // 关闭抠图是对「已应用状态」的操作，直接写历史
  updateFxSum(); updateInfo();
  run();
  toast("已关闭抠图，恢复为完整图参与转换", "ok");
});
$("brush").addEventListener("input", function () {
  brushSize = +this.value;
  $("brushval").textContent = brushSize + " 格";
});
let brushSize = 4;

/* 笔刷：在蒙版上涂。左键 = 保留（补豆），右键 = 扣除。
   只在蒙版粒度上改，改完增量重算——不重跑抠图服务，交互因此没有网络延迟。 */
let brushing = false, brushErase = false, brushStrokeBefore = null;
editwrap.addEventListener("pointerdown", function (e) {
  if (refine.mode !== "matt" || cropDrag) return;
  if (e.button !== 0 && e.button !== 2) return;
  // ★ 编辑条上的按下不是落笔 —— 必须最先排除。
  // 这个监听绑在整个 editwrap 上，编辑条是它的子元素：不排除的话，点工具条的
  // 「确认/取消」会被当成笔刷落笔（preventDefault + setPointerCapture 把指针
  // 捕获走），click 永远到不了按钮 —— matt 模式的工具条从 v1.2 起就整条是死的，
  // 旧验收恰好只点侧栏按钮、从未点过编辑条，所以一直没暴露。
  if (e.target.closest && e.target.closest("#editbar")) return;
  e.preventDefault();
  brushing = true;
  brushErase = (e.button === 2);
  // setPointerCapture 仅是「拖出元素仍收到事件」的优化，且在合成事件/部分设备上会抛异常。
  // 必须包起来：它一抛，下面的 brushing / brushStrokeBefore 就都没设上，
  // 笔刷会表现为「怎么涂都没反应」，而 paintBrush 本身完全正常。
  try { editwrap.setPointerCapture(e.pointerId); } catch (err) { /* 忽略即可 */ }
  const t = state.target;
  // 没抠过就当作「全保留」再涂：蒙版锚定当前工作区
  if (!refine.mask) setMask(new Uint8Array(MASK_N * MASK_N).fill(1), workRect());
  brushStrokeBefore = refine.mask.slice();
  paintBrush(e.clientX, e.clientY);
});
editwrap.addEventListener("pointermove", function (e) {
  if (!brushing) return;
  paintBrush(e.clientX, e.clientY);
});
["pointerup", "pointercancel"].forEach(function (t) {
  editwrap.addEventListener(t, function () {
    if (!brushing) return;
    brushing = false;
    editwrap.classList.remove("grabbing");
    // 一笔 = 会话内一笔（可被「撤销一笔」回退）；全局历史等「确认」时才写。
    // 旧实现在这里改写 hist[histPos].mask 再压栈 —— 属于对历史栈的越权hack，
    // 撤销语义混乱且会被会话取消一起冲掉。
    draft.strokes.push(brushStrokeBefore);
    $("mattctl").hidden = false;
    masterSig = "";
    updateFxSum(); updateInfo();
    run();
  });
});
editwrap.addEventListener("contextmenu", function (e) {
  if (refine.mode === "matt") e.preventDefault();
});
function paintBrush(clientX, clientY) {
  if (!refine.mask) return;
  const t = state.target;
  const p = toImage(clientX, clientY);
  const R = refine._maskRect || workRect();
  // 全部换算到「工作区归一化坐标」：笔刷半径的单位是目标格（t 分之一的工作区）
  const cx = (p.x - R.x) / R.w, cy = (p.y - R.y) / R.h;
  const rN = brushSize / 2 / t, r2 = rN * rN;
  const N = MASK_N;
  const x0 = Math.max(0, Math.floor((cx - rN) * N)), x1 = Math.min(N - 1, Math.ceil((cx + rN) * N));
  const y0 = Math.max(0, Math.floor((cy - rN) * N)), y1 = Math.min(N - 1, Math.ceil((cy + rN) * N));
  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) / N - cx, dy = (y + 0.5) / N - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * N + x;
      const v = brushErase ? 0 : 1;
      if (refine.mask[i] !== v) { refine.mask[i] = v; changed = true; }
    }
  }
  if (changed) renderEditOverlay();
}
let mattOverlayStyle = "blend";   // blend = 红标注叠底图；only = 只看蒙版（需求 §2.5.3）
/* 蒙版离屏画布：把 refine.mask（MASK_N²）逐像素写成红/绿色块，再一次性 drawImage
   拉伸到工作区。红色标注与后端返回、笔刷、主网格分析用的是**同一份** refine.mask，
   逐像素一致 —— 显示即所得（P1 交互修复：红色抠除区域必须完整覆盖后端扣除范围）。 */
let maskCv = null;
function drawMaskOverlay(g, Rm) {
  const N = MASK_N, m = refine.mask;
  if (!maskCv) maskCv = workingCanvas(N, N);
  const mctx = maskCv.getContext("2d", { willReadFrequently: true });
  const img = mctx.createImageData(N, N);
  const d = img.data;
  const only = (mattOverlayStyle === "only");
  for (let i = 0; i < m.length; i++) {
    const kept = m[i] === 1;
    if (!only && kept) continue;                    // 叠底图：保留区透明，露出原图
    const o = i * 4;
    if (kept) { d[o] = 46; d[o + 1] = 125; d[o + 2] = 91; d[o + 3] = 240; }   // 只看蒙版：绿=保留
    else      { d[o] = 185; d[o + 1] = 31; d[o + 2] = 58; d[o + 3] = only ? 240 : 92; } // 红=扣除
  }
  mctx.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;                  // 关闭插值：蒙版格边缘清晰、不渗 alpha
  g.drawImage(maskCv, Rm.x, Rm.y, Rm.w, Rm.h);
  g.imageSmoothingEnabled = true;
}
/* 蒙版叠加显示：blend = 半透明红叠底图；only = 只看蒙版（绿保留/红扣除） */
function renderEditOverlay() {
  if (!imageData) return;
  const r = editwrap.getBoundingClientRect();
  if (!r.width) return;
  // ★ buffer 必须 = 图片原大：画布局部坐标 = 图片像素坐标逐像素成立，
  //   屏幕映射完全交给元素级 CSS transform（applyView，与 editimg 同一组）。
  //   旧实现把 buffer 做成视口大小、却用图片像素坐标绘制 —— 图片大于视口时
  //   （几乎总是如此）超出 buffer 的标注被整体裁掉，红色抠除区域只能显示
  //   左上一块，正是「抠除区域显示不完全」的直接原因。
  const iw = imageData.width, ih = imageData.height;
  if (editov.width !== iw) editov.width = iw;
  if (editov.height !== ih) editov.height = ih;
  editov.style.width = iw + "px";
  editov.style.height = ih + "px";
  ectx.setTransform(1, 0, 0, 1, 0, 0);
  ectx.clearRect(0, 0, iw, ih);

  // 裁剪模式：框由 DOM 负责，这里补一条「框内居中最大正方形」的虚线参考 ——
  // 让用户直观看到哪一块会进入图纸、哪两侧会被丢弃（需求 §2.5.4 G3：破坏性改动先预告）
  if (refine.mode === "crop" && refine.cropPendingCrop) {
    const c = refine.cropPendingCrop;
    if (Math.abs(c.w - c.h) > 1) {
      const side = Math.min(c.w, c.h);
      const gx = c.x + (c.w - side) / 2, gy = c.y + (c.h - side) / 2;
      ectx.setLineDash([7, 5]);
      ectx.strokeStyle = "rgba(255,255,255,.95)";
      ectx.lineWidth = 2 / view.s;                 // 屏幕上恒定 2px
      ectx.strokeRect(gx, gy, side, side);
      ectx.setLineDash([]);
    }
  }
  if (refine.mode !== "matt" || !refine.mask) return;

  const Rm = refine._maskRect || workRect();
  // 红色抠除区域：按蒙版分辨率逐像素渲染（不再按预览档位「格中心采样」——
  // 旧画法会把部分被扣的边界格漏标成保留，红区系统性偏小）
  drawMaskOverlay(ectx, Rm);

  // 网格辅助线（预览档位）：让用户看清笔刷半径落在哪些格上。
  // 只画线不裁剪 —— 画布会自行裁掉可视区外部分，无需再做可视窗口推算。
  const t = state.target;
  const xOf = function (nx) { return Rm.x + nx * Rm.w; };
  const yOf = function (ny) { return Rm.y + ny * Rm.h; };
  if (Rm.w / t * view.s > 6) {                     // 屏幕上每格不足 6px 时不画线（噪点）
    ectx.strokeStyle = "rgba(255,255,255,.30)";
    ectx.lineWidth = 1 / view.s;                   // 屏幕上恒定 ~1px
    ectx.beginPath();
    for (let x = 0; x <= t; x++) {
      const px = xOf(x / t);
      ectx.moveTo(px, yOf(0)); ectx.lineTo(px, yOf(1));
    }
    for (let y = 0; y <= t; y++) {
      const py = yOf(y / t);
      ectx.moveTo(xOf(0), py); ectx.lineTo(xOf(1), py);
    }
    ectx.stroke();
  }
}
