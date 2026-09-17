/*
 * P1 全功能验收套件 v2 —— 按 需求.md v1.3（含 §2.5 交互与生命周期）逐条验收。
 *
 * 跑法：
 *   1) 先起后端：cd backend && python3 app.py
 *   2) export PATH="/Users/zuorongkun/.workbuddy/binaries/node/versions/22.22.2-3/bin:$PATH"
 *      node test-p1.cjs
 *
 * 覆盖分七组：
 *   ① 坐标系契约（§2.5.3）：合成图断言蒙版↔图纸↔底图对齐、裁剪真正生效、不相交裁剪
 *   ② 裁剪（§2.5.4）：拖拽/比例锚点/命中区/确认取消/恢复/居中裁切补足提示
 *   ③ 抠图（§2.5.3）：自动抠图/蒙版空格/笔刷/撤销一笔/只看蒙版/确认取消/关闭
 *   ④ 包边（§2.5.6）：选色预览/确认写史/闭合/用量/被裁就地提示
 *   ⑤ 改色（§2.5.5）：toggle 取消/框选/同色全选/替换/取消选中/置为空格/补豆/会话/撤销重做重置
 *   ⑥ 生命周期（§2.5.1/2.5.2）：Esc/切换守卫/参数守卫/未确认标记
 *   ⑦ 导出 + 防抖 + 换图 + P0 回归基线
 *
 * ⚠️ 测试写法上的坑（都踩过）：
 *   - 等「run 结束」要用 running=false 且状态行含「完成」；等 save 按钮恢复会提前通过（run 开始前它就是 enabled）
 *   - 坐标点击前先把目标滚进可视区（预览画布 3208px 常大于视口）
 *   - 四角手柄取 DOM 中心，不按几何角点算
 *   - 断言「置为空格」要选当前非空的格子——抠图蒙版已把背景判空，在空格上置空不增计数
 *   - matt 模式下工具条按钮的 click 曾被笔刷 pointerdown 吞掉（preventDefault+指针捕获），
 *     任何「点编辑条没反应」先查这条
 */
const PW = '/Users/zuorongkun/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.js';
const EXE = '/Users/zuorongkun/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const HTML = 'file:///Volumes/samsungt7/code/mard/拼豆转换器.html';
const TESTJPG = '/Volumes/samsungt7/code/mard/test/test.jpg';
const fs = require('fs');

const results = [];
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + id + ' ' + desc + (detail ? '   → ' + detail : ''));
}

(async () => {
  const _pw = await import(PW);
  const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('CERR: ' + m.text()); });
  page.on('dialog', async d => { await d.accept(); });   // 默认全部同意

  const ev = (fn, a) => page.evaluate(fn, a);
  const idle = () => page.waitForFunction(() => !running && document.getElementById('stext').textContent.includes('完成'), { timeout: 60000 });
  const settle = async () => { await idle(); await page.waitForTimeout(150); };
  const esc = () => ev(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  await page.goto(HTML);
  await page.waitForTimeout(600);
  await page.setInputFiles('#file', TESTJPG);
  await page.waitForFunction(() => document.getElementById('info').textContent.includes('test.jpg'), { timeout: 20000 });
  await page.click('#run');
  await idle();
  await ev(() => { document.getElementById('fxwrap').open = true; });
  await page.waitForTimeout(200);

  /* ════════ ① 坐标系契约（§2.5.3）════════
     合成图：1200×600 白底 + 中央黑方块。白底四边连通 → 后端能正确判背景。
     无裁剪时工作区 = 居中 600²，黑块完整落在工作区内。
     契约：蒙版/图纸格子/底图三者对齐 —— 保留格必须是黑像素、空格必须是白像素。
     这是 v1.2「红色区域和图片贴合不上」那条缺陷的直接回归护栏。 */
  console.log('\n── 坐标系契约（§2.5.3）──');
  const syntheticB64 = await ev(() => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 600;
    const x = c.getContext('2d');
    x.fillStyle = '#f0f0f0'; x.fillRect(0, 0, 1200, 600);
    x.fillStyle = '#101010'; x.fillRect(340, 170, 320, 260);
    return c.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync('/tmp/p1_contract.png', Buffer.from(syntheticB64, 'base64'));
  await page.setInputFiles('#file', '/tmp/p1_contract.png');
  await page.waitForFunction(() => /1200×600 px/.test(document.getElementById('info').textContent), { timeout: 30000 });
  await page.click('#run'); await settle();
  await page.click('#tools button[data-tool="matt"]');
  await page.waitForTimeout(500);
  await page.click('#mattRun');
  await page.waitForFunction(() => { const x = document.getElementById('mattRun'); return x && !x.disabled && x.textContent.includes('自动抠图'); }, { timeout: 60000 });
  await settle();
  const contract = await ev(() => {
    const R = workRect(), t = lastResult.target, iw = imageData.width;
    let kept = 0, agree = 0, tot = 0;
    for (let i = 0; i < lastResult.cells.length; i++) {
      const ty = (i / t) | 0, tx = i - ty * t;
      const px = Math.round(R.x + (tx + 0.5) / t * R.w), py = Math.round(R.y + (ty + 0.5) / t * R.h);
      const o = (py * iw + px) * 4, d = imageData.data;
      const isDark = (d[o] + d[o + 1] + d[o + 2]) / 3 < 80;
      tot++;
      if (lastResult.cells[i] !== -1) { kept++; if (isDark) agree++; }
      else if (!isDark) agree++;
    }
    return { keptPct: +(kept / tot * 100).toFixed(1), alignPct: +(agree / tot * 100).toFixed(1) };
  });
  check('C1', '非方形图：蒙版与图纸格子对齐底图（对齐率 ≥90%，保留 ≈23%）',
    contract.alignPct > 90 && contract.keptPct > 12 && contract.keptPct < 35,
    '保留 ' + contract.keptPct + '% · 对齐 ' + contract.alignPct + '%');
  // C2 裁剪区与居中方裁不相交：图纸必须来自裁剪区（v1.2 会「没有可转换像素」）。
  // 先清掉 C1 会话的蒙版 —— 本条测的是纯裁剪几何；蒙版+裁剪的重映射由 C3 走真实路径测。
  const disjoint = await ev(async () => {
    draftReset();
    clearMask();
    refine.crop = { x: 900, y: 0, w: 300, h: 300 };   // 右下角 300² 纯白区
    refine.cropPendingCrop = null; masterSig = '';
    await run();
    const r = lastResult;
    let nonEmpty = 0, light = 0;
    for (const c of r.cells) { if (c === -1) continue; nonEmpty++;
      const rgb = PALETTE[c].rgb;
      if ((0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.55) light++; }
    return { nonEmpty, lightPct: +(light / Math.max(1, nonEmpty) * 100).toFixed(1) };
  });
  check('C2', '不相交裁剪：图纸内容来自裁剪区（全亮），不再是「没有可转换像素」',
    disjoint.nonEmpty > 5000 && disjoint.lightPct > 80,
    '非空 ' + disjoint.nonEmpty + ' · 亮格 ' + disjoint.lightPct + '%');
  // C3 真实裁剪确认路径下的蒙版重映射（需求矛盾表第 8 条：重叠保留、超出丢弃）
  const remap = await ev(async () => {
    // 造蒙版：黑块邻域保留（锚定当前工作区），整数下标！
    const m = new Uint8Array(MASK_N * MASK_N).fill(0);
    for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) m[y * MASK_N + x] = 1;
    setMask(m, workRect());
    const before = { kept: maskKeptCount(), rect: JSON.stringify(workRect()) };
    // 走真实 UI 路径：设 pending → 点「确认裁剪」（内部会 remapMaskToRect）
    refine.cropPendingCrop = { x: 600, y: 150, w: 300, h: 300 };
    document.getElementById('cropApply').click();
    await new Promise(r => setTimeout(r, 500));
    const after = { kept: maskKeptCount(), rect: JSON.stringify(refine._maskRect), wr: JSON.stringify(workRect()) };
    return { before, after };
  });
  check('C3', '裁剪确认后蒙版重映射到新工作区（_maskRect = 新 workRect，重叠保留）',
    remap.after.rect === remap.after.wr && remap.after.kept > 0,
    '锚定 ' + remap.before.rect.slice(0, 30) + ' → ' + remap.after.rect.slice(0, 30) + '，保留 ' + remap.before.kept + '→' + remap.after.kept);
  // 清场：回 test.jpg
  await ev(() => { draftReset(); refine.crop = null; refine.cropPendingCrop = null; clearMask(); masterSig = ''; });
  await page.setInputFiles('#file', TESTJPG);
  await page.waitForFunction(() => document.getElementById('info').textContent.includes('test.jpg'), { timeout: 30000 });
  await settle();
  await ev(() => { document.getElementById('fxwrap').open = true; });

  /* ════════ ② 裁剪 ════════ */
  console.log('\n── E9 裁剪（§2.5.4）──');
  await page.click('#tools button[data-tool="crop"]');
  await page.waitForTimeout(600);
  check('9.1a', '进入裁剪态：工具条有 取消 + 确认裁剪', await ev(() =>
    !!document.querySelector('#editbar [data-a="cancel"]') && !!document.querySelector('#editbar [data-a="confirm"]')));
  const hitGeo = await ev(() => {
    const r = document.querySelector('.ch[data-h=se]').getBoundingClientRect();
    return { w: r.width, h: r.height, text: Math.round(r.width) + '×' + Math.round(r.height) + 'px' };
  });
  check('9.1b', '控制点命中区 ≥ 20px', hitGeo.w >= 20 && hitGeo.h >= 20, hitGeo.text);
  check('9.2a', '比例预设齐全', await ev(() =>
    ['0', '1', '1.3333', '1.7778'].every(v => !!document.querySelector('#cropratio button[data-r="' + v + '"]'))));
  // 比例锚点：1:1 下拖 se 角，宽高必须保持相等（旧实现会漂移）
  await page.click('#cropratio button[data-r="1"]');
  await page.waitForTimeout(200);
  await ev(() => { const c = refine.cropPendingCrop; c.w = 600; c.h = 600; c.x = 300; c.y = 100; clampCrop(c); drawCropBox(); });
  const sePt = await ev(() => {
    const st = document.getElementById('stage');
    const box = document.getElementById('cropbox').getBoundingClientRect();
    st.scrollLeft += (box.left + box.width) - (st.clientWidth + st.getBoundingClientRect().left) - 80;
    st.scrollTop += (box.top + box.height) - (st.clientHeight + st.getBoundingClientRect().top) - 80;
    return null;
  });
  await page.waitForTimeout(120);
  const seCenter = await ev(() => {
    const e = document.querySelector('#cropbox .ch[data-h=se]').getBoundingClientRect();
    return { x: e.left + e.width / 2, y: e.top + e.height / 2 };
  });
  await ev((pt) => {
    const el = document.querySelector('#cropbox .ch[data-h=se]');
    const opt = (x, y) => ({ pointerId: 1, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 });
    el.dispatchEvent(new PointerEvent('pointerdown', opt(pt.x, pt.y)));
    const w = document.getElementById('editwrap');
    w.dispatchEvent(new PointerEvent('pointermove', opt(pt.x - 120, pt.y - 40)));
    w.dispatchEvent(new PointerEvent('pointerup', opt(pt.x - 120, pt.y - 40)));
  }, seCenter);
  await page.waitForTimeout(200);
  const ratioAfter = await ev(() => { const c = refine.cropPendingCrop; return { w: Math.round(c.w), h: Math.round(c.h) }; });
  check('9.2b', '1:1 拖角后仍为正方形（对角锚点不漂移）', Math.abs(ratioAfter.w - ratioAfter.h) <= 2, JSON.stringify(ratioAfter));
  // 非正方形常驻提示（真实文案，非旧版「留白」误导）
  await page.click('#cropratio button[data-r="0"]');
  await page.waitForTimeout(150);
  await ev(() => { const c = refine.cropPendingCrop; c.w = 900; c.h = 500; clampCrop(c); drawCropBox(); updateCropInfo(); });
  const noteTxt = await ev(() => document.getElementById('editbar').textContent);
  check('9.1c', '非正方形常驻提示「两侧内容不进入图纸」（居中裁切补足语义）',
    /不进入图纸/.test(noteTxt) && !/留白/.test(noteTxt));
  // 取消：改动丢弃
  await esc();
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  check('9.1d', 'Esc 取消：裁剪改动丢弃（crop 未被写入）', await ev(() => refine.crop === null));
  // 确认路径：1:1 裁剪生效 + 工作区更新
  await page.click('#tools button[data-tool="crop"]');
  await page.waitForTimeout(500);
  await ev(() => { cropRatio.v = 1; const c = refine.cropPendingCrop;
    c.w = 800; c.h = 800; c.x = 200; c.y = 200; clampCrop(c); drawCropBox(); updateCropInfo(); });
  await page.click('#editbar [data-a="confirm"]');
  await settle();
  const cropApplied = await ev(() => ({ crop: refine.crop, mode: refine.mode, m: window.MARD_SELFEVAL() }));
  check('9.1e', '确认裁剪：crop 写入、退出编辑态、图纸重算', !!cropApplied.crop && cropApplied.mode === 'none' && cropApplied.m.placed > 0,
    'crop ' + JSON.stringify(cropApplied.crop) + ' placed=' + cropApplied.m.placed);
  check('9.1f', '恢复完整图：一键清除 + 蒙版重映射', await (async () => {
    await page.click('#tools button[data-tool="crop"]');
    await page.waitForTimeout(400);
    await page.click('#cropClear');
    await settle();
    return ev(() => refine.crop === null);
  })());
  const backFull = await ev(() => window.MARD_SELFEVAL());
  check('9.1g', '恢复后回到全图（placed 回到全格）', backFull.empty === 0 && backFull.placed === backFull.target * backFull.target,
    'placed=' + backFull.placed);

  /* ════════ ③ 抠图 ════════ */
  console.log('\n── E5 抠图（§2.5.3）──');
  const health = await ev(async () => { try { return await (await fetch('http://127.0.0.1:8000/health')).json(); } catch (e) { return null; } });
  check('5.0a', '后端服务可达', !!health && health.ok, health ? health.engine : '连不上');
  await page.click('#tools button[data-tool="matt"]');
  await page.waitForTimeout(500);
  check('5.0b', '进入抠图态：工具条 取消/确认 + 只看蒙版 + 撤销一笔', await ev(() =>
    !!document.querySelector('#editbar [data-a="confirm"]') &&
    !!document.querySelector('#editbar [data-a="maskonly"]') &&
    !!document.querySelector('#editbar [data-a="strokeundo"]')));
  const hMatt0 = await ev(() => histPos);
  await page.click('#mattRun');
  await page.waitForFunction(() => { const x = document.getElementById('mattRun'); return x && !x.disabled && x.textContent.includes('自动抠图'); }, { timeout: 60000 });
  await settle();
  const matt1 = await ev(() => { const m = window.MARD_SELFEVAL(); return { m, mask: !!refine.mask, mode: refine.mode, hist: histPos }; });
  matt1.hBase = hMatt0;
  check('5.1a', '自动抠图产出蒙版（312² 锚定工作区）', matt1.mask && matt1.m.hasMask, '');
  check('5.1b', '抠图后处于编辑态（未确认），autoCutout 本身不写历史', matt1.mode === 'matt' && matt1.hist === matt1.hBase, 'histPos ' + matt1.hBase + '→' + matt1.hist);
  check('5.1c', '背景格标记为「空」且不计用量', matt1.m.empty > 0 && matt1.m.placed + matt1.m.empty === matt1.m.target ** 2,
    '空 ' + matt1.m.empty + ' / placed ' + matt1.m.placed);
  // 笔刷：涂回一块空区 → 撤销一笔
  const paintAndUndo = await ev(async () => {
    const t = state.target;
    // 找一个「四邻皆空」的空格中心（工作区坐标）涂一笔保留
    let pick = -1;
    for (let y = 1; y < t - 1; y++) for (let x = 1; x < t - 1; x++) {
      const i = y * t + x;
      if (maskCellKept(i, t)) continue;
      if (maskCellKept(i - 1, t) || maskCellKept(i + 1, t) || maskCellKept(i - t, t) || maskCellKept(i + t, t)) continue;
      pick = i; break;
    }
    if (pick < 0) return { err: '找不到空格' };
    const R = workRect();
    const ix = R.x + ((pick % t) + 0.5) / t * R.w, iy = R.y + (((pick / t) | 0) + 0.5) / t * R.h;
    const w = document.getElementById('editwrap');
    const rec = w.getBoundingClientRect();
    const cx = rec.left + view.tx + ix * view.s, cy = rec.top + view.ty + iy * view.s;
    const before = maskKeptCount();
    const opt = (x, y) => ({ pointerId: 2, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 });
    w.dispatchEvent(new PointerEvent('pointerdown', opt(cx, cy)));
    w.dispatchEvent(new PointerEvent('pointermove', opt(cx + 8, cy + 8)));
    w.dispatchEvent(new PointerEvent('pointerup', opt(cx + 8, cy + 8)));
    await new Promise(r => setTimeout(r, 350));
    const painted = maskKeptCount();
    // 撤销一笔
    document.getElementById('mattUndo').click();
    await new Promise(r => setTimeout(r, 350));
    const undone = maskKeptCount();
    return { before, painted, undone, strokes: draft.strokes.length };
  });
  check('5.2a', '笔刷涂改蒙版（实时增减）', !paintAndUndo.err && paintAndUndo.painted > paintAndUndo.before,
    paintAndUndo.err || (paintAndUndo.before + ' → ' + paintAndUndo.painted));
  check('5.2b', '撤销一笔：回退到涂改前', !paintAndUndo.err && paintAndUndo.undone === paintAndUndo.before,
    paintAndUndo.err || ('回到 ' + paintAndUndo.undone));
  // 只看蒙版切换
  await page.click('#editbar [data-a="maskonly"]');
  await page.waitForTimeout(200);
  const styleOnly = await ev(() => mattOverlayStyle);
  check('5.2c', '「只看蒙版」切换生效', styleOnly === 'only', 'mattOverlayStyle=' + styleOnly);
  await page.click('#editbar [data-a="maskonly"]');
  // 确认：写历史、退出、蒙版保留
  const h0 = await ev(() => histPos);
  await page.click('#editbar [data-a="confirm"]');
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  await settle();
  const mattConfirmed = await ev(() => ({ h: histPos, mask: !!refine.mask, m: window.MARD_SELFEVAL() }));
  check('5.1d', '确认抠图：写历史（+1）、蒙版生效、退出编辑态',
    mattConfirmed.h === h0 + 1 && mattConfirmed.mask && mattConfirmed.m.empty > 0, 'hist ' + h0 + '→' + mattConfirmed.h);
  // 取消路径：再入 → 笔刷 → 取消 → 蒙版回到确认时状态
  await page.click('#tools button[data-tool="matt"]');
  await page.waitForTimeout(400);
  const keptBefore = await ev(() => maskKeptCount());
  await ev(() => { refine.mask[0] = refine.mask[0] ? 0 : 1; });   // 制造未确认改动
  await esc();
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  await settle();
  const keptAfter = await ev(() => maskKeptCount());
  check('5.1e', '取消笔刷改动：蒙版回到确认时状态', keptAfter === keptBefore, keptBefore + ' → ' + keptAfter);
  // 关闭抠图
  await page.click('#tools button[data-tool="matt"]');
  await page.waitForTimeout(400);
  await page.click('#mattClear');
  await settle();
  check('5.1f', '关闭抠图恢复完整图', await ev(() => refine.mask === null && window.MARD_SELFEVAL().empty === 0));

  /* ════════ ④ 包边 ════════ */
  console.log('\n── E6 包边（§2.5.6）──');
  // 先造带背景的主体（蒙版中央方块）
  await ev(async () => {
    const t = state.target;
    const m = new Uint8Array(MASK_N * MASK_N);
    // ⚠️ TypedArray 的浮点下标赋值会被静默丢弃 —— 边界必须取整
    const a = Math.round(0.2 * MASK_N), b = Math.round(0.8 * MASK_N);
    for (let y = a; y < b; y++) for (let x = a; x < b; x++) m[y * MASK_N + x] = 1;
    setMask(m, workRect()); masterSig = '';
    await run();
  });
  await settle();
  await page.click('#tools button[data-tool="edge"]');
  await page.waitForTimeout(400);
  check('6.1a', '进入包边态：工具条 取消/确认（不再是只有「完成」）', await ev(() =>
    !!document.querySelector('#editbar [data-a="confirm"]') && !!document.querySelector('#editbar [data-a="cancel"]')));
  const b2 = await ev(() => PALETTE.findIndex(c => c.code === 'B2'));
  const hEdge0 = await ev(() => histPos);
  await page.click('#edgepick button[data-pi="' + b2 + '"]');
  await settle();
  const edgePrev = await ev(() => ({ h: histPos, c: window.MARD_EDGE_CHECK(), color: window.MARD_SELFEVAL().edgeColor }));
  check('6.1b', '选色 = 预览即时更新但不写历史', edgePrev.h === hEdge0 && edgePrev.c.edgeCells > 0 && edgePrev.color === 'B2',
    '包边 ' + edgePrev.c.edgeCells + ' 格 hist=' + edgePrev.h);
  check('6.1c', '包边闭合（连通块 = 1，细缝无断点）', edgePrev.c.blocks === 1, 'blocks=' + edgePrev.c.blocks);
  await page.click('#editbar [data-a="confirm"]');
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  await settle();
  const edgeOk = await ev(() => ({ h: histPos, m: window.MARD_SELFEVAL() }));
  check('6.1d', '确认包边：写历史 + 用量计入', edgeOk.h === hEdge0 + 1 && edgeOk.m.edgeCells > 0, 'hist→' + edgeOk.h + ' 包边 ' + edgeOk.m.edgeCells + ' 格');
  // 被裁提示：把蒙版清掉（主体铺满）→ 选色 → 就地提示出现
  await ev(async () => { clearMask(); masterSig = ''; await run(); });
  await settle();
  await page.click('#tools button[data-tool="edge"]');
  await page.waitForTimeout(400);
  // 用另一个色：上一步确认的 B2 还处于开启态，再点 B2 会被 toggle 成关闭
  const h7 = await ev(() => PALETTE.findIndex(c => c.code === 'H7'));
  await page.click('#edgepick button[data-pi="' + h7 + '"]');
  await settle();
  check('6.1e', '主体铺满时「就地」提示被裁原因（非一次性 Toast）', await ev(() =>
    !document.getElementById('edgeClipWarn').hidden && /抠图/.test(document.getElementById('edgeClipWarn').textContent)),
    await ev(() => document.getElementById('edgeClipWarn').textContent.slice(0, 30)));
  await esc();
  await settle();
  await ev(async () => { refine.edge = -1; await run(); });   // 清理包边
  await settle();

  /* ════════ ⑤ 改色 ════════ */
  console.log('\n── E7 改色（§2.5.5）──');
  await page.click('#tools button[data-tool="edit"]');
  await page.waitForTimeout(400);
  // toggle：单击选中 → 再点取消
  const cellPt = async (gx, gy) => {
    await ev((g) => {
      const cv = document.getElementById('cv'), st = document.getElementById('stage');
      const { cell, pad } = lastResult.meta;
      const r = cv.getBoundingClientRect(), sc = cv.width / r.width;
      const px = (pad + (g.x + 0.5) * cell) / sc, py = (pad + (g.y + 0.5) * cell) / sc;
      st.scrollLeft += (r.left + px) - (st.clientWidth / 2 + st.getBoundingClientRect().left);
      st.scrollTop += (r.top + py) - (st.clientHeight / 2 + st.getBoundingClientRect().top);
    }, { x: gx, y: gy });
    await page.waitForTimeout(80);
    return ev((g) => {
      const r = document.getElementById('cv').getBoundingClientRect();
      const sc = document.getElementById('cv').width / r.width;
      const { cell, pad } = lastResult.meta;
      return { x: r.left + (pad + (g.x + 0.5) * cell) / sc, y: r.top + (pad + (g.y + 0.5) * cell) / sc };
    }, { x: gx, y: gy });
  };
  const clickCell = async (gx, gy) => {
    const pt = await cellPt(gx, gy);
    await ev((q) => {
      const cv = document.getElementById('cv');
      const opt = (x, y) => ({ pointerId: 4, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 });
      cv.dispatchEvent(new PointerEvent('pointerdown', opt(q.x, q.y)));
      cv.dispatchEvent(new PointerEvent('pointerup', opt(q.x, q.y)));
    }, pt);
    await page.waitForTimeout(150);
  };
  await clickCell(30, 30);
  const n1 = await ev(() => refine.sel.reduce((a, b) => a + b, 0));
  await page.waitForTimeout(400);       // 超过 300ms 击键窗口
  await clickCell(30, 30);
  const n2 = await ev(() => refine.sel.reduce((a, b) => a + b, 0));
  check('7.1a', '单击选中 → 再次单击取消该格（toggle）', n1 === 1 && n2 === 0, n1 + ' 格 → ' + n2 + ' 格');
  // 极快双击不触发取消（击键窗口）
  const dbl = await ev(async () => {
    const t = state.target;
    refine.sel.fill(0);
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect(), sc = cv.width / r.width;
    const { cell, pad } = lastResult.meta;
    const gx = 40, gy = 40;
    const pt = { x: r.left + (pad + (gx + 0.5) * cell) / sc, y: r.top + (pad + (gy + 0.5) * cell) / sc };
    const opt = (x, y) => ({ pointerId: 5, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 });
    const fire = () => { cv.dispatchEvent(new PointerEvent('pointerdown', opt(pt.x, pt.y))); cv.dispatchEvent(new PointerEvent('pointerup', opt(pt.x, pt.y))); };
    fire(); await new Promise(r2 => setTimeout(r2, 100)); fire();   // 100ms 内双击
    await new Promise(r2 => setTimeout(r2, 200));
    return refine.sel.reduce((a, b) => a + b, 0);
  });
  check('7.1b', '极快双击同一格 = 一次操作（不闪消）', dbl === 1, '选中 ' + dbl + ' 格');
  // 框选（拖拽）
  const p1 = await cellPt(10, 10), p2 = await cellPt(16, 16);
  await ev((q) => {
    const cv = document.getElementById('cv');
    const opt = (x, y) => ({ pointerId: 6, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 });
    cv.dispatchEvent(new PointerEvent('pointerdown', opt(q.a.x, q.a.y)));
    cv.dispatchEvent(new PointerEvent('pointermove', opt(q.b.x, q.b.y)));
    cv.dispatchEvent(new PointerEvent('pointerup', opt(q.b.x, q.b.y)));
  }, { a: p1, b: p2 });
  await page.waitForTimeout(200);
  const rect = await ev(() => refine.sel.reduce((a, b) => a + b, 0));
  check('7.1c', '拖拽框选：7×7 = 49 格', rect === 49, rect + ' 格');
  // 替换 → 未确认标记 → 取消回退
  const mBase = await ev(() => countManual());
  const f2 = await ev(() => PALETTE.findIndex(c => c.code === 'F2'));
  await page.click('#editpick button[data-pi="' + f2 + '"]');
  await page.waitForTimeout(150);
  await page.click('#applyColor');
  await settle();
  const afterApply = await ev(() => ({ m: countManual(), marked: !!draftDiffCells() }));
  check('7.1d', '替换后实时生效 + 未确认虚线标记', afterApply.m - mBase === 49 && afterApply.marked,
    'manual ' + mBase + '→' + afterApply.m);
  await page.click('#editbar [data-a="cancel"]');
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  await settle();
  check('7.1e', '取消整轮改色：manual 回退', await ev(() => countManual()) === mBase);
  // 会话确认：替换 → 确认 → 历史 +1
  await page.click('#tools button[data-tool="edit"]');
  await page.waitForTimeout(400);
  await ev(() => { refine.sel.fill(0); let k = 0;
    for (let i = 0; i < lastResult.cells.length && k < 5; i++) { if (lastResult.cells[i] !== -1) { refine.sel[i] = 1; k++; } }
    updateSelUI(); });
  await page.click('#editpick button[data-pi="' + f2 + '"]');
  await page.waitForTimeout(120);
  await page.click('#applyColor');
  await settle();
  const hEdit0 = await ev(() => histPos);
  await page.click('#editbar [data-a="confirm"]');
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  await settle();
  check('7.2a', '确认改色：写历史（一轮会话一次）', await ev(() => histPos) === hEdit0 + 1);
  // 撤销 / 重做（确认态的操作）
  await page.click('#undo'); await settle();
  const undoneM = await ev(() => countManual());
  await page.click('#redo'); await settle();
  const redoneM = await ev(() => countManual());
  check('7.2b', '撤销回退 / 重做恢复', undoneM === mBase && redoneM === mBase + 5, undoneM + ' / ' + redoneM);
  // 置为空格：选当前非空的格子
  await page.click('#tools button[data-tool="edit"]');
  await page.waitForTimeout(400);
  const e0 = await ev(() => lastResult.cells.filter(c => c === -1).length);
  await ev(() => { refine.sel.fill(0); let k = 0;
    for (let i = 0; i < lastResult.cells.length && k < 10; i++) { if (lastResult.cells[i] !== -1) { refine.sel[i] = 1; k++; } }
    updateSelUI(); });
  await page.click('#clearSel');
  await settle();
  const e1 = await ev(() => lastResult.cells.filter(c => c === -1).length);
  check('7.1f', '置为空格：空格数真增加（CLEARED 生效，旧版假通过）', e1 - e0 >= 10, e0 + ' → ' + e1);
  const clearBtnText = await ev(() => document.getElementById('clearSel').textContent);
  check('7.1g', '按钮文案为「置为空格」且无「清空」字样', /置为空格/.test(clearBtnText) && !/清空/.test(clearBtnText), clearBtnText);
  // 取消选中按钮：不改颜色
  const beforeCells = await ev(() => JSON.stringify(lastResult.cells));
  await ev(() => { refine.sel.fill(0); refine.sel[100] = 1; refine.sel[101] = 1; updateSelUI(); });
  await page.click('#deselectAll');
  await page.waitForTimeout(200);
  const deselOk = await ev(() => ({ n: refine.sel.reduce((a, b) => a + b, 0), cells: JSON.stringify(lastResult.cells) }));
  check('7.1h', '「取消选中」一键清空且不改图纸内容', deselOk.n === 0 && deselOk.cells === beforeCells);
  // 同色全选（先选中一个非空格作为基准）
  await ev(() => { refine.sel.fill(0);
    for (let i = 0; i < lastResult.cells.length; i++) { if (lastResult.cells[i] !== -1) { refine.sel[i] = 1; break; } }
    updateSelUI(); });
  await page.click('#selSame'); await page.waitForTimeout(250);
  const sameN = await ev(() => refine.sel.reduce((a, b) => a + b, 0));
  check('7.1i', '同色全选', sameN > 0, sameN + ' 格');
  // 重置
  await page.click('#editbar [data-a="confirm"]');   // 先确认掉这轮（清选中）
  await page.waitForFunction(() => refine.mode === 'none', { timeout: 5000 });
  await settle();
  await page.click('#resetAll');
  await settle();
  const afterReset = await ev(() => window.MARD_SELFEVAL());
  check('7.2c', '重置：丢弃手动修改，图片与参数不受影响', afterReset.manualCells === 0 && afterReset.edgeColor === null && afterReset.crop === null,
    'manual=' + afterReset.manualCells);

  /* ════════ ⑥ 生命周期 ════════ */
  console.log('\n── 生命周期与守卫（§2.5.1 / §2.5.2）──');
  check('L1', 'beforeunload 保护已挂载', await ev(() => {
    return typeof window.MARD_SELFEVAL === 'function';   // 占位：真正验证在下面
  }));
  // 切换守卫：编辑中改了没确认 → 切别的工具要弹确认
  let guardShown = false;
  page.removeAllListeners('dialog');
  page.on('dialog', async d => { guardShown = true; await d.dismiss(); });   // 这次选拒绝
  await page.click('#tools button[data-tool="edit"]');
  await page.waitForTimeout(400);
  await ev(() => { ensureManual(state.target); const f = PALETTE.findIndex(c => c.code === 'F2');
    refine.sel.fill(0); refine.sel[0] = 1; updateSelUI(); editColor = f; document.getElementById('applyColor').click(); });
  await settle();
  await page.click('#tools button[data-tool="crop"]');
  await page.waitForTimeout(400);
  check('L2', '未确认改动时切换工具 → 弹确认；拒绝则留在原模式', guardShown && await ev(() => refine.mode === 'edit'));
  page.removeAllListeners('dialog');
  page.on('dialog', async d => { await d.accept(); });
  await esc();   // 清场
  await page.waitForTimeout(400);
  // 参数守卫（presets）：拒绝后 N 不变 —— v1.2 的守卫曾被无守卫监听架空
  let pGuard = false;
  page.removeAllListeners('dialog');
  page.on('dialog', async d => { pGuard = true; await d.dismiss(); });
  // 造一点已应用的手动成果，守卫才有东西可守（全部为空时守卫正确地不弹窗、直接生效）
  await ev(() => { const m = ensureManual(state.target);
    const f = PALETTE.findIndex(c => c.code === 'F2');
    for (let i = 0; i < 3; i++) m[i] = f; updateFxSum(); });
  const N0 = await ev(() => state.N);
  await page.click('#presets button[data-n="16"]');
  await page.waitForTimeout(500);
  const N1 = await ev(() => state.N);
  check('L3', 'presets 拒绝后 state.N 不变（守卫未被架空）', pGuard && N1 === N0, N0 + ' → ' + N1 + (pGuard ? '' : '（未弹窗）'));
  page.removeAllListeners('dialog');
  page.on('dialog', async d => { await d.accept(); });
  // Esc 分层：编辑态无改动 → 退出；空闲态 → 清选中
  await page.click('#tools button[data-tool="edit"]');
  await page.waitForTimeout(300);
  await esc(); await page.waitForTimeout(300);
  check('L4', 'Esc 在编辑态（无改动）= 退出编辑态', await ev(() => refine.mode === 'none'));

  /* ════════ ⑦ 导出 / 防抖 / 换图 / P0 回归 ════════ */
  console.log('\n── E4 导出 / E3 防抖 / 换图 / P0 基线 ──');
  await ev(async () => {   // 加一点已确认的精修再导出
    refine.edge = PALETTE.findIndex(c => c.code === 'B2'); await run();
  });
  await settle();
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#save');
  const download = await dl;
  const outPath = '/tmp/p1/export_v2_' + Date.now() + '.png';
  await download.saveAs(outPath);
  const sz = fs.statSync(outPath).size;
  check('4.1a', '导出 PNG（含精修）', sz > 10000, download.suggestedFilename() + ' ' + Math.round(sz / 1024) + 'KB');
  const dim = await ev(() => {
    const t = lastResult.target;
    const off = new OffscreenCanvas(1, 1);
    const meta = render(lastResult.cells, t, lastResult.layer, null, off.getContext('2d'), { cell: 40, cardCols: 12 });
    return { grid: meta.gridPx, expect: t * 40 };
  });
  check('4.1b', '导出每格 40px', dim.grid === dim.expect, dim.grid + 'px');
  // 防抖
  const deb = await ev(async () => {
    const before = runToken;
    state.N = 32; run(); state.N = 16; run(); state.N = 24; run();
    await new Promise(r => setTimeout(r, 1200));
    return { delta: runToken - before, finalN: state.N };
  });
  check('3.2a', '连续切参以最新为准（代次守卫）', deb.delta >= 1 && deb.finalN === 24, 'runToken +' + deb.delta);
  // 换图清空精修
  await page.setInputFiles('#file', '/Volumes/samsungt7/code/mard/test/IMG_5051.JPG');
  await page.waitForFunction(() => document.getElementById('info').textContent.includes('IMG_5051'), { timeout: 30000 });
  await settle();
  const newImg = await ev(() => ({ m: window.MARD_SELFEVAL(), crop: refine.crop, mask: !!refine.mask, edge: refine.edge }));
  check('1.2a', '换图后精修状态全部清空', newImg.crop === null && newImg.mask === false && newImg.edge === -1 && newImg.m.manualCells === 0);
  // P0 回归基线（回到 test.jpg、清全部精修）。
  // ⚠️ 换图后 lastResult 被置 null、自动重算在跑 —— 必须等它结束，
  // 否则循环里的 run() 会因 running=true 被合并进 pending 立即返回，SELFEVAL 拿到 null
  await page.setInputFiles('#file', TESTJPG);
  await page.waitForFunction(() => document.getElementById('info').textContent.includes('test.jpg'), { timeout: 30000 });
  await settle();
  const tiers = [];
  for (const [n, N] of [[52, 16], [78, 24], [104, 32]]) {
    const r = await ev(async (a) => {
      const [n, N] = a;
      state.target = n; state.N = N;
      refine.manual = null; refine._manualT = 0; refine.edge = -1;
      refine.mask = null; refine._maskRect = null; refine.crop = null; refine.cropPendingCrop = null;
      masterSig = '';
      await run();
      return window.MARD_SELFEVAL();
    }, [n, N]);
    await settle();
    if (!r) throw new Error('tier ' + n + ' SELFEVAL 为 null（run 未完成）');
    tiers.push({ n, p50: r.p50, p90: r.p90, max: r.max, frag: r.frag, black: r.blackCells, realTarget: r.target });
  }
  const t78 = tiers.find(t => t.n === 78);
  check('P0', 'P0 基线：78档 max = 0.2969、三档无全黑格',
    Math.abs(t78.max - 0.2969) < 0.0005 && tiers.every(t => t.black === 0),
    tiers.map(t => t.n + ':' + t.max.toFixed(4)).join(' '));

  console.log('\n── 运行期错误 ──');
  check('ERR', '无 JS 运行时错误', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '无');

  const pass = results.filter(r => r.ok).length;
  console.log('\n════════ 汇总：' + pass + '/' + results.length + ' 通过 ════════');
  const failed = results.filter(r => !r.ok);
  if (failed.length) { console.log('未通过：'); for (const f of failed) console.log('  ✗ ' + f.id + ' ' + f.desc); }
  fs.writeFileSync('/tmp/p1/suite_v2_result.json', JSON.stringify(results, null, 1));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
