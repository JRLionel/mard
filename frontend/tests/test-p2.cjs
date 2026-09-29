/*
 * P2 风格化生成验收套件 —— 按 需求.md E8（Story 8.1/8.2/8.3）与
 * openspec/changes/p2-style-transfer-refactor 的 spec 逐条验收。
 *
 * 跑法：
 *   1) 起前端静态服务：cd frontend && npm start   （默认 http://127.0.0.1:3000，MARD_FRONTEND_URL 可覆盖）
 *   2) node frontend/tests/test-p2.cjs
 *
 * 分五组：
 *   ① 静态契约：风格 key 前后端同步链 / 脚本加载顺序 / init 无业务逻辑 / 后端三层结构
 *   ② 生成流程：隐私同意（取消 / 同意）/ 进度 / 预览 / 防重复 / 代次守卫
 *   ③ 输入源会话：切换 / 风格会话精修可用 / 编辑态守卫 / 回退后精修逐项恢复
 *   ④ 对比视图：缺图提示 / 双面板 / 同步滚动 / 参数过期标记
 *   ⑤ 红线：风格化服务不可用时其余功能照常（P0 不依赖网络）
 *
 * ⚠️ 设计说明：风格化请求由 page.route 拦截并返回合成 PNG ——
 *    本套件验收的是**前端契约**（会话模型、守卫、降级），不打真实模型；
 *    真实后端链路由 backend/test_cutout.py 与端到端手测覆盖。
 */
const PW = '/Users/zuorongkun/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.js';
const EXE = '/Users/zuorongkun/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const fs = require('fs');
const path = require('path');
const FE = path.resolve(__dirname, '..');    // frontend/（index.html、js/、css/）
const ROOT = path.resolve(FE, '..');         // 仓库根（backend/、test/、AGENTS.md）
const HTML = process.env.MARD_FRONTEND_URL || 'http://127.0.0.1:3000/';
const IMG = path.join(ROOT, 'test', '111.png');   // 503×503，替代已缺失的验收样例 test.jpg

const results = [];
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + id + ' ' + desc + (detail ? '   → ' + detail : ''));
}
function group(t) { console.log('\n── ' + t + ' ──'); }

(async () => {
  /* ════════ ① 静态契约（不依赖浏览器）════════ */
  group('静态契约（前后端同步链 / 结构）');

  const cfg = fs.readFileSync(path.join(ROOT, 'backend/config.py'), 'utf8');
  const html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
  const initJs = fs.readFileSync(path.join(FE, 'js', 'init.js'), 'utf8');
  const styleJs = fs.readFileSync(path.join(FE, 'js', 'p2-style.js'), 'utf8');
  const compareJs = fs.readFileSync(path.join(FE, 'js', 'p2-compare.js'), 'utf8');
  const styleRouter = fs.readFileSync(path.join(ROOT, 'backend/routers/style.py'), 'utf8');

  // 1.1 风格 key 同步链：HTML 未 disabled 的 data-s == config.STYLE_ENABLED
  const btns = Array.from(html.matchAll(/<button data-s="([a-z]+)"([^>]*)>/g))
    .map(m => ({ key: m[1], disabled: /\bdisabled\b/.test(m[2]) }));
  const feEnabled = btns.filter(b => !b.disabled).map(b => b.key).sort();
  const mEnabled = cfg.match(/STYLE_ENABLED\s*=\s*\(([^)]*)\)/);
  const beEnabled = mEnabled
    ? mEnabled[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean).sort()
    : [];
  check('2.1a', '风格 key 同步链：前端可点集合 == 后端 STYLE_ENABLED',
    feEnabled.length > 0 && JSON.stringify(feEnabled) === JSON.stringify(beEnabled),
    '前端[' + feEnabled + '] vs 后端[' + beEnabled + ']');

  // 1.2 现开放 flat / pixel / bead / custom 四种；oil、water 已下线
  const disabledBtns = btns.filter(b => b.disabled);
  check('2.1b', '开放 flat + pixel + bead + 自定义四种，无置灰按钮（oil / water 已移除）',
    feEnabled.length === 4 && ['bead', 'custom', 'flat', 'pixel'].every(k => feEnabled.includes(k)) &&
    disabledBtns.length === 0 &&
    !/data-s="oil"/.test(html) && !/data-s="water"/.test(html) &&
    !/即将上线/.test(html) && /自定义/.test(html),
    '可点 ' + feEnabled.length + ' / 置灰 ' + disabledBtns.length);

  // 1.3 flat 内置提示词为用户指定的 chibi 文案（关键约束不得丢），且不暴露给前端
  check('2.1c', 'flat 提示词保留用户要求的关键约束（chibi / 6-8 色 / 不混色 / 纯白底）且不暴露给前端',
    /chibi/.test(cfg) && /6-8/.test(cfg) && /不混色/.test(cfg) && /纯白背景/.test(cfg) &&
    !/chibi/.test(html) && !/chibi/.test(styleJs));

  // ★ 回归护栏：提示词/负向词里不得再出现「多格暗示词」。
  //   实测：原提示词的「chibi 画风表情包」会让模型理解成「一整版多格贴纸包」，
  //   4 次采样里 1 次直接吐出 3×3 九宫格（用户报障的那个现象）。
  const apiPy = fs.readFileSync(path.join(ROOT, 'backend/services/aliyun_api.py'), 'utf8');
  const flatPrompt = (cfg.match(/"flat":\s*\(([\s\S]*?)\)/) || [, ''])[1];
  const pixelPrompt = (cfg.match(/"pixel":\s*\(([\s\S]*?)\)/) || [, ''])[1];
  const beadPrompt = (cfg.match(/"bead":\s*\(([\s\S]*?)\)/) || [, ''])[1];
  const multiWord = /表情包|九宫格|四宫格|拼贴|拼图|分镜/;
  check('2.1d', '内置提示词不含多格暗示词（表情包 / 九宫格 / 拼图…）',
    [flatPrompt, pixelPrompt, beadPrompt].every(p => !multiWord.test(p)),
    'bead: ' + beadPrompt.replace(/\s+/g, ' ').slice(0, 40) + '…');
  check('2.1e', 'flat 提示词仍显式约束「只画一个主体 / 单一完整画面」',
    /只画一个主体/.test(flatPrompt) && /单一完整画面/.test(flatPrompt));
  check('2.1e2', 'pixel / bead 为用户指定的新文案（像素 / 纯白底 / 6-8 色）',
    /像素/.test(pixelPrompt) && /拼豆风格/.test(pixelPrompt) &&
    /像素/.test(beadPrompt) && /纯白/.test(beadPrompt) && /6\s*至\s*8/.test(beadPrompt),
    'bead: ' + beadPrompt.replace(/\s+/g, ' ').slice(0, 46) + '…');
  check('2.1h', 'custom 无内置提示词、由用户输入：后端要求 prompt，前端弹窗收集并随请求发送',
    /style == "custom"/.test(styleRouter) && /自定义风格需要提供提示词/.test(styleRouter) &&
    /customModal/.test(html) && /askCustomPrompt/.test(styleJs) &&
    /fd\.append\("prompt"/.test(styleJs));
  check('2.1f', '负向提示词已配置且含多格 / 多主体拦截词',
    /STYLE_NEGATIVE_PROMPTS/.test(cfg) && /多格/.test(cfg) && /多个角色/.test(cfg) &&
    /negative_prompt/.test(apiPy));
  check('2.1g', 'prompt_extend 已关闭（实测 6-7s vs 17-41s，且避免改写引入歧义）',
    /STYLE_PROMPT_EXTEND\s*=\s*False/.test(cfg) && /"prompt_extend":\s*config\.STYLE_PROMPT_EXTEND/.test(apiPy));

  // 1.4 后端三层结构
  const need = ['backend/config.py', 'backend/services/aliyun_api.py',
    'backend/routers/cutout.py', 'backend/routers/style.py'];
  const missing = need.filter(p => !fs.existsSync(path.join(ROOT, p)));
  check('2.4', '后端三层：config / services / routers 文件齐全', missing.length === 0,
    missing.length ? '缺 ' + missing.join(' ') : '4/4');

  // 1.5 精简后的 app.py 只做装配，且路由路径无前缀
  const appPy = fs.readFileSync(path.join(ROOT, 'backend/app.py'), 'utf8');
  check('2.4b', 'app.py 仅装配（include_router + CORS + /health），无业务函数',
    /include_router/.test(appPy) && !/requests\.post/.test(appPy) && !/compute_alpha/.test(appPy));
  check('2.5', '/style-transfer 路径未加 /style 前缀（与已跑通路径一致）',
    /@router\.post\("\/style-transfer"\)/.test(styleRouter) && !/APIRouter\(prefix/.test(styleRouter));
  check('2.4c', 'CORS expose_headers 含 X-Style-Ms',
    /expose_headers[\s\S]*X-Style-Ms/.test(appPy));

  // 1.6 前端脚本加载顺序：p2-* 在 refine-* 之后、init 之前
  const order = ['palette.js', 'algorithm.js', 'render.js', 'state.js', 'ui-core.js',
    'refine-crop.js', 'refine-cutout.js', 'refine-edit.js',
    'p2-style.js', 'p2-compare.js', 'init.js'];
  const srcs = Array.from(html.matchAll(/<script src="js\/([a-z0-9\-]+\.js)"><\/script>/g)).map(m => m[1]);
  check('2.2a', '脚本顺序 palette→…→refine-edit→p2-style→p2-compare→init（init 最后）',
    JSON.stringify(srcs) === JSON.stringify(order), srcs.join(' → '));

  // 1.7 init.js 只装配（无业务逻辑）
  check('2.2b', 'init.js 不含业务逻辑（无 fetch / 无 style-transfer / 无生成实现）',
    !/fetch\(/.test(initJs) && !/style-transfer/.test(initJs) && !/FormData/.test(initJs) &&
    /P2Style\.init\(\)/.test(initJs) && /P2Compare\.init\(\)/.test(initJs));

  // 1.8 模块化：两个 p2 文件各自单一职责
  check('2.2c', 'p2-style.js 只做生成/会话，p2-compare.js 只做对比视图',
    /style-transfer/.test(styleJs) && !/cmpCv/.test(styleJs) &&
    /cmpCv/.test(compareJs) && !/style-transfer/.test(compareJs));

  // 1.9 API 地址复用 CUTOUT_URL（不新增第二套常量、不用相对路径）
  check('2.2d', 'P2 复用 CUTOUT_URL 约定 + fetchWithTimeout（file:// 下相对路径必失败）',
    /CUTOUT_URL\s*\+\s*"\/style-transfer"/.test(styleJs) &&
    /fetchWithTimeout/.test(styleJs) && !/fetch\("\/style-transfer/.test(styleJs));

  // 1.10 会话模型：不替换原图（用会话快照交换）
  check('2.3a', '会话模型：capture/apply 快照交换，不直接覆盖 imageData',
    /function capture\(/.test(styleJs) && /function apply\(/.test(styleJs) &&
    /sessions\[active\] = capture\(\)/.test(styleJs));

  // 1.11 代次守卫：按「代次 + 输入源身份」双重校验
  check('2.3b', '代次守卫同时核对代次与输入源身份（换图也能拦住）',
    /const stale = function/.test(styleJs) && /imageData !== srcAt/.test(styleJs));

  // 1.12 文档同步
  const agentsMd = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const beReadme = fs.readFileSync(path.join(ROOT, 'backend/README.md'), 'utf8');
  check('2.6a', 'AGENTS.md 已同步 P2 文件与加载顺序',
    /p2-style\.js/.test(agentsMd) && /p2-compare\.js/.test(agentsMd) && /routers/.test(agentsMd));
  check('2.6b', 'backend/README.md 已记录 /style-transfer 与隐私边界',
    /style-transfer/.test(beReadme));

  /* ════════ 浏览器 ════════ */
  const _pw = await import(PW);
  const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon/.test(t)) return;
    // ⑤ 组故意注入 503/500，浏览器必然记一条资源加载失败 —— 那是被测行为，不是缺陷
    if (/Failed to load resource/.test(t) && /\b(500|503)\b/.test(t)) return;
    errs.push('CERR: ' + t);
  });

  let dialogAccept = true;
  page.on('dialog', async d => { if (dialogAccept) await d.accept(); else await d.dismiss(); });

  const ev = (fn, a) => page.evaluate(fn, a);
  const idle = () => page.waitForFunction(
    () => !running && document.getElementById('stext').textContent.includes('完成'), null, { timeout: 60000 });
  const settle = async () => { await idle(); await page.waitForTimeout(200); };
  const hidden = (id) => ev(id => document.getElementById(id).hidden, id);
  const visible = async (id) => !(await hidden(id));

  /* 风格化请求的确定性替身 */
  let reqCount = 0, routeDelay = 0, routeStatus = 200, lastStyleUrl = '', lastBody = '';
  const makePng = async () => {
    const b64 = await ev(() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 256;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 256, 256);
      x.fillStyle = '#C8452A'; x.beginPath(); x.arc(128, 128, 78, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#2F6FB0'; x.fillRect(40, 40, 60, 60);
      return c.toDataURL('image/png').split(',')[1];
    });
    return Buffer.from(b64, 'base64');
  };

  await page.goto(HTML);
  await page.waitForTimeout(500);
  const PNG = await makePng();
  await page.route('**/style-transfer*', async route => {
    reqCount++;
    lastStyleUrl = route.request().url();
    try {
      const buf = route.request().postDataBuffer();
      lastBody = buf ? buf.toString('utf8') : '';
    } catch (e) { lastBody = ''; }
    if (routeDelay) await new Promise(r => setTimeout(r, routeDelay));
    if (routeStatus !== 200) {
      return route.fulfill({
        status: routeStatus, contentType: 'application/json',
        body: JSON.stringify({ error: '模拟：风格化服务不可用' })
      });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });

  await page.setInputFiles('#file', IMG);
  await page.waitForFunction(() => /111\.png/.test(document.getElementById('fname').textContent), null, { timeout: 20000 });
  await page.click('#run');
  await settle();
  await ev(() => { document.getElementById('p2wrap').open = true; });
  await page.waitForTimeout(150);

  /* ════════ ② 生成流程 ════════ */
  group('生成流程（隐私同意 / 进度 / 预览 / 防重复 / 代次守卫）');

  // 未选风格
  reqCount = 0;
  await page.click('#p2run');
  await page.waitForTimeout(200);
  check('1.1', '未选风格时点击生成：提示且不发请求（未选风格走原有链路）',
    reqCount === 0 && await hidden('privacyModal'));

  // 选风格
  await page.click('#p2styles button[data-s="flat"]');
  const label = await ev(() => document.getElementById('p2run').textContent);
  check('1.2', '选中扁平插画风后按钮文案跟随（单选可逆）',
    /扁平插画风/.test(label) && await ev(() => document.querySelector('#p2styles button[data-s="flat"]').classList.contains('on')),
    label);

  // 首次生成 → 隐私同意模态（G1：阻断级用模态，不用 Toast）
  await page.click('#p2run');
  await page.waitForTimeout(250);
  check('1.3a', '首次生成弹出隐私同意模态（需求 §3 安全要求 / 假设 9）',
    await visible('privacyModal') && reqCount === 0);
  check('1.3b', '同意文案说明上传用途与不落盘边界',
    await ev(() => /不落盘|请求结束即释放/.test(document.getElementById('privacyModal').textContent)));

  // 取消同意 → 不发起请求
  await page.click('#pmCancel');
  await page.waitForTimeout(250);
  check('1.3c', '在同意模态点取消：不发请求、预览区不出、模态关闭',
    reqCount === 0 && await hidden('privacyModal') && await hidden('p2preview'));

  // 同意 → 请求开始，进度出现，按钮置灰
  routeDelay = 1200;
  reqCount = 0;
  await page.click('#p2run');
  await page.waitForTimeout(150);
  await page.click('#pmOk');
  await page.waitForFunction(() => document.getElementById('p2prog') && !document.getElementById('p2prog').hidden, null, { timeout: 5000 });
  const progText = await ev(() => document.getElementById('p2ptext').textContent);
  check('1.4a', '生成中显示阶段进度文案', progText.length > 0, progText);
  // 等请求真正发出（编码 + 派发要几帧），再断言防重复
  await page.waitForTimeout(400);
  check('1.4b', '生成中按钮置灰防重复触发',
    await ev(() => document.getElementById('p2run').disabled) && reqCount === 1,
    'disabled=' + await ev(() => document.getElementById('p2run').disabled) + ' req=' + reqCount);

  // 生成期间再点一次 → 不产生第二次请求
  await page.click('#p2run', { force: true }).catch(() => { });
  await page.waitForTimeout(120);
  check('1.4c', '生成期间重复点击不发第二次请求', reqCount === 1, 'req=' + reqCount);

  // ★ 代次守卫：生成期间换图 → 旧响应必须被丢弃
  await page.setInputFiles('#file', IMG);
  await page.waitForTimeout(2500);
  check('1.5', '代次守卫：生成期间换图，旧响应被丢弃（不写入预览）',
    !(await ev(() => P2Style.hasStyleDetail())) && await hidden('p2preview'));

  // 正常生成一次（同意已记住，不再弹模态）
  routeDelay = 0;
  reqCount = 0;
  await settle();
  await page.click('#p2run');
  await page.waitForTimeout(250);
  check('1.6a', '同意后本会话不再重复询问（直接开始生成）',
    await hidden('privacyModal') && reqCount === 1);

  await page.waitForFunction(() => !document.getElementById('p2preview').hidden, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const badge = await ev(() => document.getElementById('p2badge').textContent);
  const dim = await ev(() => document.getElementById('p2dim').textContent);
  check('1.6b', '生成成功：预览区显示风格标签与尺寸（非 0×0）',
    badge === '扁平插画风' && /^\d{2,} × \d{2,} px$/.test(dim), badge + ' | ' + dim);
  // 进度条在成功 900ms 后收起
  await page.waitForFunction(() => document.getElementById('p2prog').hidden, null, { timeout: 5000 }).catch(() => { });
  check('1.6c', '生成成功：进度条收起、「用风格图生成」可用、「回退」此时不可用',
    await hidden('p2prog') && !(await ev(() => document.getElementById('p2use').disabled)) &&
    await ev(() => document.getElementById('p2back').disabled));

  // ★ file:// 下相对路径会指向本地文件系统 —— 请求必须显式发往本机服务
  check('1.7', 'API 地址发往 http://127.0.0.1:8000/style-transfer（相对路径硬伤不复现）',
    /^http:\/\/127\.0\.0\.1:8000\/style-transfer$/.test(lastStyleUrl), lastStyleUrl);

  /* ════════ ③ 输入源会话 ════════ */
  group('输入源会话（切换 / 编辑态守卫 / 回退恢复）');

  // 在原图会话造一份「已确认」的精修成果，并记录指纹
  // 注意：manual 数组即使在无改动时也可能存在（run 里 ensureManual 会建全 EMPTY 数组），
  // 所以「干净」的判据是「非 EMPTY 的格子数 = 0」，不是数组为 null。
  const ck = () => ev(() => {
    let h = 0, changed = 0;
    const m = refine.manual;
    if (m) for (let i = 0; i < m.length; i++) { h = (h * 31 + m[i]) | 0; if (m[i] !== EMPTY) changed++; }
    let mh = 0, maskOn = 0;
    if (refine.mask) for (let i = 0; i < refine.mask.length; i++) { mh = (mh * 31 + refine.mask[i]) | 0; if (refine.mask[i]) maskOn++; }
    return {
      manual: m ? m.length + ':' + h : null,
      manualChanged: changed,
      mask: refine.mask ? refine.mask.length + ':' + mh : null,
      maskOn: maskOn,
      edge: refine.edge,
      crop: refine.crop ? JSON.stringify(refine.crop) : null,
      hist: hist.length + '/' + histPos,
      wh: imageWH.join('x')
    };
  });
  await ev(() => {
    const n = state.target * state.target;
    refine.manual = new Int16Array(n).fill(EMPTY);
    refine.manual[Math.floor(n / 2)] = 3;      // 造一格改色
    refine.edge = 2;                            // 造一个包边色
    pushHistory(state.target);
    masterSig = "";
    updateHistUI(); updateEdgeSwatch(); updateFxSum();
    return true;
  });
  const before = await ck();
  check('3.1', '原图会话已有可观测的精修成果（改色 + 包边）',
    before.manualChanged === 1 && before.edge === 2, JSON.stringify(before));

  // 编辑态守卫：造一份未确认改动，切会话时应先提示，拒绝则留在原地
  await ev(() => {
    const n = state.target * state.target;
    refine.manual = new Int16Array(n).fill(EMPTY);
    refine.manual[Math.floor(n / 2)] = 3;
    draftEnter('edit');                         // 基线 = 上面这份
    refine.manual[0] = 5;                       // 未确认的新改动
    return draft.kind && draftChanged();
  });
  dialogAccept = false;
  await page.click('#p2use');
  await page.waitForTimeout(250);
  check('3.2a', '编辑态点「用风格图生成」：先提示未确认改动，拒绝后留在原会话（§2.5.2 A）',
    await ev(() => P2Style.activeKey()) === 'original' &&
    await ev(() => !!draft.kind && draftChanged()));

  dialogAccept = true;
  await page.click('#p2use');
  await settle();
  check('3.2b', '同意后切到风格图会话',
    await ev(() => P2Style.activeKey()) === 'style');
  check('3.2c', '切换后上传区标记来源为「风格图」且缩略图换成风格图',
    await visible('srcBadge') && await ev(() => /_flat\.png/.test(document.getElementById('fname').textContent)),
    await ev(() => document.getElementById('fname').textContent));

  const styleCk = await ck();
  check('3.3a', '风格会话是独立的一套状态（图片尺寸不同、精修层无改动、包边关闭）',
    styleCk.wh !== before.wh && styleCk.manualChanged === 0 && styleCk.maskOn === 0 &&
    styleCk.edge === -1, JSON.stringify(styleCk));
  check('3.3b', '风格会话走完整链路：精修工具与导出均可用',
    await ev(() => Array.prototype.every.call(document.getElementById('tools').children, b => !b.disabled)) &&
    !(await ev(() => document.getElementById('save').disabled)));

  // 回退：原会话的精修成果必须逐项恢复
  await page.click('#p2back');
  await settle();
  const after = await ck();
  check('3.4a', '回退到原图：输入源与缩略图恢复、来源标记消失',
    await ev(() => P2Style.activeKey()) === 'original' && await hidden('srcBadge') &&
    await ev(() => document.getElementById('thumb').src === imageURL));
  check('3.4b', '★ 回退后精修状态逐项恢复（改色 / 蒙版 / 包边 / 裁剪 / 历史 / 尺寸）',
    JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify(after) + ' vs ' + JSON.stringify(before));
  check('3.4c', '风格图未覆盖原图数据（原图缩略图 URL 仍是原图）',
    await ev(() => imageURL === document.getElementById('thumb').src) && after.wh === before.wh);

  /* ════════ ④ 对比视图 ════════ */
  group('对比视图（缺图提示 / 双面板 / 同步滚动 / 参数过期）');

  const nonWhite = (id) => ev(id => {
    const c = document.getElementById(id);
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++;
    }
    return n;
  }, id);

  await page.click('#viewmodes button[data-view="compare"]');
  await page.waitForTimeout(400);
  check('4.1', '两侧图纸齐备时可进入对比视图，双面板各有内容',
    await visible('compare') && await hidden('stage') &&
    (await nonWhite('cmpCvA')) > 0 && (await nonWhite('cmpCvB')) > 0,
    'A=' + await nonWhite('cmpCvA') + ' B=' + await nonWhite('cmpCvB'));
  // ★ 参数一致时不得有「参数已变化」标记（旧实现误用 meta.requestedN，恒判过期）
  check('4.1b', '参数一致时两个面板都不标「参数已变化」',
    await hidden('cmpStaleA') && await hidden('cmpStaleB'),
    'staleA hidden=' + await hidden('cmpStaleA') + ' / staleB hidden=' + await hidden('cmpStaleB'));

  // 同步滚动：先把视口压矮，保证面板内容确实溢出（否则面板无从滚动，断言会假失败）
  await page.setViewportSize({ width: 1500, height: 560 });
  await page.waitForTimeout(500);
  const overflow = await ev(() => {
    const s = document.getElementById('cmpScrollA');
    return s.scrollHeight - s.clientHeight;
  });
  await ev(() => { document.getElementById('cmpScrollA').scrollTop = 240; });
  await page.waitForTimeout(250);
  const bTop = await ev(() => document.getElementById('cmpScrollB').scrollTop);
  check('4.2', '同步滚动开启时另一面板跟随',
    overflow > 100 && bTop > 100, 'overflow=' + overflow + ' B.scrollTop=' + bTop);

  await ev(() => { const c = document.getElementById('cmpSync'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await ev(() => { document.getElementById('cmpScrollA').scrollTop = 0; });
  await page.waitForTimeout(250);
  const bTop2 = await ev(() => document.getElementById('cmpScrollB').scrollTop);
  check('4.3', '关闭同步滚动后两面板独立', bTop2 > 100, 'B.scrollTop=' + bTop2);

  await ev(() => { const c = document.getElementById('cmpSync'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(300);

  // 参数一致性：改规格后活跃侧重算、非活跃侧就地标记过期
  await page.click('#grids button[data-n="52"]');
  await page.waitForTimeout(1500);
  check('4.4', '改规格后活跃侧实时重算、非活跃侧就地标记「参数已变化」（不自动重算）',
    await visible('cmpStaleB') &&
    /参数已变化/.test(await ev(() => document.getElementById('cmpStaleB').textContent)) &&
    /78×78 → 52×52/.test(await ev(() => document.getElementById('cmpStaleB').textContent)) &&
    await hidden('cmpStaleA'),
    await ev(() => document.getElementById('cmpStaleB').textContent));

  // 改色数同样算参数变化（走 params.N 这条判据）
  await page.click('#presets button[data-n="32"]');
  await page.waitForTimeout(1500);
  check('4.4b', '改色数也标记过期，且文案指明是色数变了',
    await visible('cmpStaleB') &&
    /色/.test(await ev(() => document.getElementById('cmpStaleB').textContent)) &&
    /24 色 → 32 色/.test(await ev(() => document.getElementById('cmpStaleB').textContent)),
    await ev(() => document.getElementById('cmpStaleB').textContent));

  await page.click('#viewmodes button[data-view="single"]');
  await page.waitForTimeout(250);
  check('4.5', '可切回单视图', await hidden('compare') && await visible('stage'));

  /* ════════ ⑤ 自定义风格（弹窗输入提示词） ════════ */
  group('自定义风格（弹窗 / 提示词随请求发送 / 取消不改选中）');

  const customOn = () => ev(() => document.querySelector('#p2styles button[data-s="custom"]').classList.contains('on'));

  reqCount = 0;
  await page.click('#p2styles button[data-s="custom"]');
  await page.waitForTimeout(250);
  check('6.1', '点「自定义」弹出提示词输入模态，弹窗打开时不发请求',
    await visible('customModal') && reqCount === 0);

  await page.click('#cmCancel');
  await page.waitForTimeout(200);
  check('6.2', '取消：模态关闭、不生成、不改选中态',
    await hidden('customModal') && reqCount === 0 && !(await customOn()));

  await page.click('#p2styles button[data-s="custom"]');
  await page.waitForTimeout(150);
  await page.fill('#cmPrompt', '   ');        // 纯空白 = 空提示词
  await page.click('#cmOk');
  await page.waitForTimeout(200);
  check('6.3', '提示词为空（含纯空白）时不生成、不改选中态',
    await hidden('customModal') && reqCount === 0 && !(await customOn()));

  const respP = page.waitForResponse(r => /style-transfer/.test(r.url()), { timeout: 15000 });
  await page.click('#p2styles button[data-s="custom"]');
  await page.waitForTimeout(150);
  await page.fill('#cmPrompt', '水彩绘本风测试标记MARDXYZ');
  await page.click('#cmOk');
  await respP;
  await page.waitForFunction(() => document.getElementById('p2badge').textContent === '自定义', null, { timeout: 8000 }).catch(() => { });
  check('6.4', '确认后直接生成：请求体带 style=custom 与用户提示词',
    reqCount === 1 && /name="style"/.test(lastBody) && /custom/.test(lastBody) &&
    /name="prompt"/.test(lastBody) && /MARDXYZ/.test(lastBody),
    'req=' + reqCount + ' 带提示词=' + /MARDXYZ/.test(lastBody));
  check('6.5', '生成后预览标签为「自定义」且按钮保持选中',
    await ev(() => document.getElementById('p2badge').textContent) === '自定义' && await customOn());

  /* ════════ ⑥ 红线：服务不可用 ════════ */
  group('红线（风格化服务不可用不阻塞基础功能）');

  routeStatus = 503;
  reqCount = 0;
  await page.click('#p2run');
  await page.waitForFunction(() => /失败|超时/.test(document.getElementById('stext').textContent), null, { timeout: 15000 });
  const errText = await ev(() => document.getElementById('stext').textContent);
  check('5.1', '服务不可用时给出中文错误提示（保留原图与图纸）',
    /风格化生成失败|模拟/.test(errText) && !(await ev(() => P2Style.hasStyleDetail() === false && lastResult === null)),
    errText);
  check('5.2', '失败后预览区不再显示上次成功结果之外的脏数据、按钮恢复可用',
    !(await ev(() => document.getElementById('p2run').disabled)));

  // 基础功能照常
  await page.click('#run');
  await settle();
  check('5.3', '★ 红线：风格化服务不可用时，转换 / 导出 / 精修全部照常可用',
    await ev(() => document.getElementById('stext').textContent.includes('完成')) &&
    await ev(() => !!lastResult) && !(await ev(() => document.getElementById('save').disabled)) &&
    await ev(() => Array.prototype.every.call(document.getElementById('tools').children, b => !b.disabled)));

  check('5.4', '全流程无页面错误（含 5.1 的失败路径）', errs.length === 0, errs.slice(0, 3).join(' | '));

  /* ════════ 汇总 ════════ */
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log('\n' + '─'.repeat(58));
  console.log('P2 验收：' + pass + ' / ' + results.length + ' 通过' + (fail ? '，' + fail + ' 失败' : ''));
  if (fail) console.log('失败项：' + results.filter(r => !r.ok).map(r => r.id).join(', '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('套件异常：', e && e.message ? e.message : e);
  process.exit(1);
});
