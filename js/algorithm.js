"use strict";
/* ============================================================
   1.1 P1 格子数据模型 —— 全流程统一用「色卡全局下标」

   ⚠️ v1.4 之前的分工是「cells = 调色板内的紧凑下标，palette 数组存色号」。
   P1 加了逐格改色之后必须换掉，原因有两个，都不是风格问题：
     1. 逐格改色要能把任意色卡的色放进任意格，紧凑下标的取值范围会随
        手动改色不断变化，越界风险与语义混乱不可避免；
     2. 抠图后「空」格需要第三种状态。空格既不是颜色也不是下标，
        紧凑下标模型里塞不进去。
   现在的模型（三处一起看）：
     cells     Int16Array，每格 = PALETTE 的全局下标；**-1 表示「空」**（背景扣除后不着色）
     palette   全局下标 → 色卡项 的映射表（保证色号唯一、用量统计不漏）
     sel       Uint8Array，0/1，逐格选中态（框选、同色全选共用）
   色卡一次转换只会用到其中一部分（用户选的「最多 N 色」），但索引空间
   始终是完整的 221，任何一格的取值都天然合法。
   ============================================================ */
const EMPTY = -1;                // 「空」格：不参与转换、不着色、不计用量（需求 §5 矛盾 5 的裁定）
const CLEARED = -2;              // 用户显式「置为空格」的标记值。与 EMPTY 的区别：
                                 // EMPTY =「覆盖层没改过这格」（蒙版说了算），CLEARED =「用户要求这格就是空」。
                                 // 旧实现把「置为空」写成 m[i]=EMPTY，等于什么都没做——已确认是 bug（见 §2.5.5）

/* ============================================================
   2. 核心算法
   ============================================================ */
const MASTER = 312;              // 52/78/104 的最小公倍数
const DOMINANT_RATIO = 0.35;     // 主导色占比阈值，低于此值回退到线性光平均色
const MAX_SRC = 1560;            // 源图预处理上限边长（312 × 5）

/* ---------- 2.0 转换输入源：裁剪 + 抠图统一成一个「像素集合」 ----------
   P0 的输入是整幅 imageData。P1 的输入是「裁剪框内、且蒙版判为主体的像素」。
   用一张与 imageData 同尺寸的权重图（Float32Array，0~1）表达这件事，
   analyzeMaster 只认权重，不需要知道自己拿到的是裁剪还是抠图的结果。
   这样做的关键好处：**裁剪与抠图都不修改 imageData 本身**（需求 Story 9.1
   明确要求裁剪非破坏性、Story 5.1 要求抠图不改原图），随时可以撤销。
   权重为 0 的像素不参与任何累加，因此既不影响主导色也不影响面积平均——
   等价于「这些像素不存在」。 */
/* workRect：本次转换实际取用的原图正方形区域 —— **全链路唯一的坐标基准**。
   历史教训（v1.3 之前的三套坐标互相打架）：cropToBlob 用「裁剪矩形」、蒙版回铺用
   「整幅 W×H 归一化」、analyzeMaster 用「整幅居中 min(W,H) 方裁」，三者直接相乘叠加，
   只有「未裁剪 + 原图正方形」这一种巧合下才重合——test.jpg 恰好就是这种图，
   所以自测全绿而真实素材必错位（实测 1200×600 半黑半白图抠图后保留 100%）。
   现在：crop == null → 整幅居中 min(W,H) 方形（与旧实现逐比特一致，P0 基线不动）；
         crop != null → 裁剪框内居中最大正方形（需求 §2.5.4「居中裁切补足」：
                        长边两侧内容丢弃、不拉伸——旧代码里这个语义只写在文案上，从未实现）。 */
function workRect() {
  if (!imageData) return { x: 0, y: 0, w: MASTER, h: MASTER };
  const W = imageData.width, H = imageData.height;
  if (!refine.crop) {
    const side = Math.min(W, H);
    return { x: (W - side) / 2, y: (H - side) / 2, w: side, h: side };
  }
  const c = refine.crop;
  const side = Math.min(c.w, c.h);
  return { x: c.x + (c.w - side) / 2, y: c.y + (c.h - side) / 2, w: side, h: side };
}

/* 权重只承载蒙版（soft alpha）。裁剪的排除不再靠「框外置 0」——
   analyzeMaster 的格子划分只覆盖 workRect，框外像素根本不会被读到。
   好处：非正方形裁剪不会再出现「框与居中方裁交集之外整块判空」的怪象。 */
function buildWeights(mask) {
  const w = imageData.width, h = imageData.height;
  const W = new Float32Array(w * h);
  W.fill(1);
  if (mask) {
    for (let i = 0, n = w * h; i < n; i++) W[i] *= mask[i] * (1 / 255);
  }
  return W;
}

/* 2.1 主网格分析：一次遍历同时得到「线性光面积平均」与「主导色」
   weights：与 srcW×srcH 同尺寸的 0~1 权重（裁剪 / 抠图）；不传则视为整幅等权。 */
function analyzeMaster(img, rect, weights) {
  const data = img.data;
  const srcW = img.width, srcH = img.height;
  // 格子划分只覆盖工作区（恒为正方形）。crop==null 时 workRect 与旧实现的
  // 居中 min(W,H) 方裁逐比特一致 —— 这是 P0 回归基线的安全锚点，改这里前必须跑基线。
  const side = rect.w;
  const ox = rect.x, oy = rect.y;
  const step = side / MASTER;

  const out = new Uint8Array(MASTER * MASTER * 3);
  const weight = new Float32Array(MASTER * MASTER);   // 每格落在「像素集合」内的比例，0 = 全空
  const hist = new Int32Array(32768);
  // 容量必须覆盖 32768 个桶：一个格子若触及的桶数超过容量，越界写会被静默丢弃，
  // 而 touchedN 继续增长 → 清账漏桶 → 累加数组残留脏数据污染后续格子的主导色。
  const touched = new Int32Array(32768);
  // 众数桶内像素的线性光累计和与权重和：主导色取「桶内真实均值」而非桶中心。
  // 旧版解码用 bucket*8+4，每通道带 ±4/255 的系统性偏差，合成 ΔEOk 可到 ~0.02——
  // 而色卡浅色段近邻色号间距只有 0.005~0.02（附录 A），足以把最近色号翻成隔壁。
  const sLr = new Float32Array(32768), sLg = new Float32Array(32768),
    sLb = new Float32Array(32768), sW = new Float32Array(32768);

  for (let gy = 0; gy < MASTER; gy++) {
    const y0 = oy + gy * step, y1 = y0 + step;
    const iy0 = Math.max(0, Math.floor(y0)), iy1 = Math.min(srcH, Math.ceil(y1));
    for (let gx = 0; gx < MASTER; gx++) {
      const x0 = ox + gx * step, x1 = x0 + step;
      const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(srcW, Math.ceil(x1));

      let ar = 0, ag = 0, ab = 0, wsum = 0, total = 0, rawW = 0;
      let touchedN = 0, bestBin = 0, bestCount = 0;

      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        const rowOff = y * srcW;
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const p = (rowOff + x) * 4;
          // 权重 0 = 这个像素不参与（裁剪框外 / 蒙版判为背景），等价于它不存在
          const wRaw = wx * wy;
          const w = wRaw * (weights ? weights[rowOff + x] : 1);
          rawW += wRaw;
          if (w <= 0) continue;
          const r = data[p], g = data[p + 1], b = data[p + 2];
          const lr = SRGB_LIN[r], lg = SRGB_LIN[g], lb = SRGB_LIN[b];
          ar += lr * w; ag += lg * w; ab += lb * w;
          wsum += w; total++;
          // 主导色的「票」也按权重算：这样 soft alpha 的边缘不会被当成整票，
          // 蒙版边界处的半透明像素不会主导该格的色号决策
          const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          if (hist[bin] === 0) touched[touchedN++] = bin;
          sLr[bin] += lr * w; sLg[bin] += lg * w; sLb[bin] += lb * w; sW[bin] += w;
          hist[bin] += w;
          if (hist[bin] > bestCount) { bestCount = hist[bin]; bestBin = bin; }
        }
      }
      // 注意顺序：主导色的三个分量必须在清账之前算出来。
      // sW[bestBin] 若在清零后再读就是 0，0/0 = NaN 会被 linearToSrgb 吞成 0（纯黑）。
      const o = (gy * MASTER + gx) * 3;
      const domW = sW[bestBin];
      const domR = domW > 0 ? linearToSrgb(sLr[bestBin] / domW) : 0;
      const domG = domW > 0 ? linearToSrgb(sLg[bestBin] / domW) : 0;
      const domB = domW > 0 ? linearToSrgb(sLb[bestBin] / domW) : 0;

      for (let i = 0; i < touchedN; i++) {
        const tb = touched[i];
        hist[tb] = 0; sLr[tb] = 0; sLg[tb] = 0; sLb[tb] = 0; sW[tb] = 0;
      }

      if (total > 0 && domW > 0 && bestCount / total >= DOMINANT_RATIO) {
        // 主导色：取桶内像素的线性光均值——几乎不产生原图没有的颜色，
        // 边缘锐利（抗灰边），且不再受 8 级分桶的中心量化偏差影响
        out[o] = domR; out[o + 1] = domG; out[o + 2] = domB;
      } else {
        // 色彩混杂区（渐变/噪点）：回退线性光平均，避免色带跳动
        out[o]     = wsum > 0 ? linearToSrgb(ar / wsum) : 255;
        out[o + 1] = wsum > 0 ? linearToSrgb(ag / wsum) : 255;
        out[o + 2] = wsum > 0 ? linearToSrgb(ab / wsum) : 255;
      }
      // 整格权重（该格落在「像素集合」内的比例）：0 说明这格完全在裁剪/蒙版之外，
      // 下游据此判「空」格。用原始覆盖率 wsum/rawW 归一，避免 soft alpha 把边缘格
      // 的比例压得偏低而误判为空。
      weight[gy * MASTER + gx] = rawW > 0 ? wsum / rawW : 0;
    }
  }
  return { rgb: out, weight: weight };
}

/* 2.2 近色抑制 —— 避免同时选中肉眼分不出的色号（附录 A）
   返回**全局下标**数组（而不是色卡对象），下游一律用全局下标寻址 PALETTE。 */
function suppressNearDuplicates(pool, thr) {
  const idx = pool.map(function (c) { return c._gi; });
  if (thr <= 0) return idx;
  const n = pool.length;
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let j = 0; j < n; j++) if (j !== i && dEok(pool[i].ok, pool[j].ok) < thr) d++;
    deg[i] = d;
  }
  const order = Array.from({ length: n }, function (_, i) { return i; })
    .sort(function (a, b) { return deg[a] - deg[b]; });
  const dead = new Uint8Array(n), kept = [];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (dead[i]) continue;
    kept.push(idx[i]);
    for (let j = 0; j < n; j++) if (j !== i && dEok(pool[i].ok, pool[j].ok) < thr) dead[j] = 1;
  }
  return kept;
}

/* 2.3 受限贪心加色 —— 在真实色卡集合内直接挑 N 色（不会撞色）
   返回**全局下标**数组。 */
function greedyPalette(samples, poolIdx, N, onCurve) {
  const chosen = [], curve = [];
  const best = new Float64Array(samples.length).fill(Infinity);

  for (let k = 0; k < N; k++) {
    let bestG = -1, bestGain = 0;
    for (let ci = 0; ci < poolIdx.length; ci++) {
      const gi = poolIdx[ci];
      const co = PALETTE[gi].ok;
      let gain = 0;
      for (let i = 0; i < samples.length; i++) {
        const d = dEok(samples[i], co);
        if (d < best[i]) gain += best[i] - d;
      }
      if (gain > bestGain) { bestGain = gain; bestG = gi; }
    }
    if (bestG < 0 || bestGain <= 1e-9) break;   // 无增益即收敛（D5「最多 N 色」）
    chosen.push(bestG);
    const co = PALETTE[bestG].ok;
    for (let i = 0; i < samples.length; i++) {
      const d = dEok(samples[i], co);
      if (d < best[i]) best[i] = d;
    }
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += best[i] * best[i];
    curve.push(Math.sqrt(s / samples.length));
  }
  if (onCurve) onCurve(curve);
  return chosen;
}

/* 2.4 最近色号查表：全局下标 → 距目标最近的「已选色」下标。
   没选到任何色时返回 EMPTY，避免调用方拿到 undefined。 */
function nearestInSet(L, A, B, palIdx) {
  let bi = EMPTY, bd = Infinity;
  for (let j = 0; j < palIdx.length; j++) {
    const p = PALETTE[palIdx[j]].ok;
    const d0 = L - p[0], d1 = A - p[1], d2 = B - p[2];
    const d = d0 * d0 + d1 * d1 + d2 * d2;
    if (d < bd) { bd = d; bi = palIdx[j]; }
  }
  return bi;
}

/* 2.5 全图归属（312 主网格 → 全局色卡下标）。
   masterW 为每格的主体内占比：占比过低（默认 <12%）的格直接判「空」，
   不参与量化、不着色、不计用量——这是需求 Story 5.1 假设的第 4 条。 */
let MASTER_EMPTY_W = 0.12;
function assignAll(masterOk, masterW, palIdx) {
  const n = palIdx.length;
  const idx = new Int16Array(MASTER * MASTER);
  for (let i = 0, len = MASTER * MASTER; i < len; i++) {
    if (masterW && masterW[i] < MASTER_EMPTY_W) { idx[i] = EMPTY; continue; }
    const o = i * 3;
    const L = masterOk[o], A = masterOk[o + 1], B = masterOk[o + 2];
    let bi = EMPTY, bd = Infinity;
    for (let j = 0; j < n; j++) {
      const p = PALETTE[palIdx[j]].ok;
      const d0 = L - p[0], d1 = A - p[1], d2 = B - p[2];
      const d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < bd) { bd = d; bi = palIdx[j]; }
    }
    idx[i] = bi;
  }
  return idx;
}

/* 2.6 整数分块降采样 —— 「源色优先 + 选票约束」。
   旧版纯众数投票是「两次量化后的选票」：先把子格各自归属到色号，再投票选一个——
   整格的真实颜色（源色均值）从头到尾没参与决策，跨边缘格的众数还会因平票随机获胜
   （细线被吞、颜色任选其一）。旧版唯一用了源色均值的是 unifyFlatRegions 里 ≥4 格的大块。
   新版：众数份额 ≥ MODE_SHARE 时直接用众数（绝大多数格子，行为不变）；
   否则收集得票 ≥ 20% 的色号作候选——候选都是区内真实出现的颜色，不会发明灰边脏色——
   再选「离整格源色均值最近」的那个，平票不再随机。

   P1 变化：黑白名单从「调色板局部下标」换成「全局色卡下标」；
   并新增「空格」——参与格（非 -1）占比不足的空源格，整格判空。 */
let MODE_SHARE = 0.3;          // 众数份额低于此值才启用「源色候选」重选（可调，便于实测对比）。
                               // 实测 0.3 是当前最优折中：碎块率 2.10%→1.45%（接近 v1.2 的 1.41%），
                               // 代价是 p50/p90/max 略升（0.0225/0.0610/0.2600 → 0.0230/0.0653/0.2969）。
                               // 设 ≥1 即完全关闭该规则（纯众数投票）。
let CELL_EMPTY_W = 0.35;       // 目标格主体占比低于此值 → 整格判「空」
function downsampleByMode(src, target, srcOk, srcW, palIdx) {
  const step = MASTER / target;
  const out = new Int16Array(target * target);
  const tally = new Int32Array(PALETTE.length);      // 按全局下标计数
  for (let ty = 0; ty < target; ty++) {
    const y0 = Math.round(ty * step), y1 = Math.round((ty + 1) * step);
    for (let tx = 0; tx < target; tx++) {
      const x0 = Math.round(tx * step), x1 = Math.round((tx + 1) * step);
      const total = (y1 - y0) * (x1 - x0);
      let nonEmpty = 0, wSum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * MASTER;
        for (let x = x0; x < x1; x++) {
          const c = src[row + x];
          if (c !== EMPTY) nonEmpty++;
          wSum += srcW[row + x];
        }
      }
      // 这一格在主体里的占比不够 → 判「空」
      if (wSum / total < CELL_EMPTY_W || nonEmpty === 0) { out[ty * target + tx] = EMPTY; continue; }

      for (let y = y0; y < y1; y++) {
        const row = y * MASTER;
        for (let x = x0; x < x1; x++) {
          const c = src[row + x];
          if (c !== EMPTY) tally[c]++;
        }
      }
      // ⚠️ 找众数必须与「清账」分成两个循环。
      // 曾把它合并成 `if (tally[c] > bv) {...} tally[c] = 0;`，清账顺手把计数提前抹平了，
      // 于是下面「源色候选」分支读 tally 时全是 0、候选集为空，该分支静默退化成「保留众数」。
      // 后果：max 源色误差从 0.2969 涨到 0.3681（p50/p90 也各差一点），而功能看起来完全正常。
      // 同一数组既读又写的合并循环极易出这类静默错，务必分开写。
      let bi = EMPTY, bv = 0;
      for (let c = 0; c < PALETTE.length; c++) {
        if (tally[c] > bv) { bv = tally[c]; bi = c; }
      }
      let pick = bi;
      if (bv / nonEmpty < MODE_SHARE) {
        const q = (ty * target + tx) * 3;
        const L = srcOk[q], A = srcOk[q + 1], B = srcOk[q + 2];
        let bd = Infinity;
        for (let c = 0; c < PALETTE.length; c++) {
          if (tally[c] < 2) continue;
          const p = PALETTE[c].ok;
          const d0 = L - p[0], d1 = A - p[1], d2 = B - p[2];
          const d = d0 * d0 + d1 * d1 + d2 * d2;
          if (d < bd) { bd = d; pick = c; }
        }
      }
      for (let c = 0; c < PALETTE.length; c++) tally[c] = 0;   // 清账
      out[ty * target + tx] = pick;
    }
  }
  return out;
}

/* 2.4b 预计算整幅主网格的 OKLab —— 归属与平坦区判断都要用，避免重复转换 */
function buildMasterOk(master) {
  const n = MASTER * MASTER;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const lr = SRGB_LIN[master[o]], lg = SRGB_LIN[master[o + 1]], lb = SRGB_LIN[master[o + 2]];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    out[o]     = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }
  return out;
}

/* 2.7b 目标网格上的「源色」——每个目标格覆盖的主网格单元的平均色（OKLab）。
   空格（主网格全空）的源色置为 NaN 哨兵不可行（后续距离计算会污染），
   改为把它的源色设成同网格邻居的色——因为空格最终会被下游跳过，这里只要保证
   数值有限即可，不参与任何输出。 */
function targetSourceOk(masterOk, masterW, target) {
  const step = MASTER / target;
  const out = new Float32Array(target * target * 3);
  for (let ty = 0; ty < target; ty++) {
    const y0 = Math.round(ty * step), y1 = Math.round((ty + 1) * step);
    for (let tx = 0; tx < target; tx++) {
      const x0 = Math.round(tx * step), x1 = Math.round((tx + 1) * step);
      let l = 0, a = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * MASTER;
        for (let x = x0; x < x1; x++) {
          const o = (row + x) * 3;
          // 只对主体内的主网格单元取平均：把背景像素算进「源色」会让
          // 边缘格的源色偏向背景色，平坦区判断随之出错
          if (masterW[row + x] < MASTER_EMPTY_W) continue;
          l += masterOk[o]; a += masterOk[o + 1]; b += masterOk[o + 2]; n++;
        }
      }
      const q = (ty * target + tx) * 3;
      if (n > 0) { out[q] = l / n; out[q + 1] = a / n; out[q + 2] = b / n; }
      // n === 0（整格都是空）：留 0，下游不会读它的误差
    }
  }
  return out;
}

/* 2.6 平坦区统一 —— 修「量化把看不见的差异放大成看得见的色差」这个真 bug。
   源图里视觉均匀的一片（水彩纸纹理、墙面、天空）逐格源色差可能只有 0.003，
   但色卡里离它最近的两个色号可能相差 0.05，是前者的十几倍。
   逐格独立取最近色 → 源图上看不出的噪声被放大成两块肉眼分明的大色斑。
   实测 test.jpg 左上背景源色差中位数仅 0.0027，输出却在 A2 / H2 之间跳变。
   解法：先在「源色」空间做区域增长，把视觉上均匀的格子并成一块，
   再让整块统一取「最接近该块均值」的色号。
   v1.3 起增长条件是双阈值：相邻格局部差 ≤ UNIFY_LOCAL（不许跨真实边缘），
   且与区域均值差 ≤ UNIFY_SPREAD（不许顺着渐变无限蔓延）。
   真实边缘的源色差远大于这两个阈值，轮廓因此不受影响。 */
let UNIFY_LOCAL = 0.09;           // 局部连续阈值：相邻格源色差超过它就断开。实测 0.02 会把水彩纸纹理
                                  // 这类「视觉均匀但逐格有微抖动」的一片打散，碎块率从 1.4% 涨到 3.5%，
                                  // 所以放到 0.09（≈真实边缘量级之下），实际起断开作用的是 UNIFY_SPREAD。
let UNIFY_SPREAD = 0.045;         // 散布上限：候选格与区域均值的差超过它就不吸入（防渐变被链式吞成一个区域）
const UNIFY_MIN_AREA = 4;         // 小于此面积的块不强求统一（保护细碎真细节）
function unifyFlatRegions(cells, srcOk, target, palIdx) {
  const n = target * target;
  const out = new Int16Array(cells);
  const seg = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const members = new Int32Array(n);
  let sid = 0;

  for (let s = 0; s < n; s++) {
    if (seg[s] >= 0 || cells[s] === EMPTY) continue;   // 空格不参与统一，也不做区域种子
    const so = s * 3;
    let sumL = srcOk[so], sumA = srcOk[so + 1], sumB = srcOk[so + 2];
    let qs = 0, qe = 0, mc = 0;
    queue[qe++] = s; seg[s] = sid;

    while (qs < qe) {
      const p = queue[qs++];
      members[mc++] = p;
      if (mc > 1) {                       // 后加入的成员按序补进均值
        const po = p * 3;
        sumL += srcOk[po]; sumA += srcOk[po + 1]; sumB += srcOk[po + 2];
      }
      const mL = sumL / mc, mA = sumA / mc, mB = sumB / mc;
      const y = (p / target) | 0, x = p - y * target;
      for (let k = 0; k < 4; k++) {
        let q = -1;
        if (k === 0 && x > 0)          q = p - 1;
        if (k === 1 && x < target - 1) q = p + 1;
        if (k === 2 && y > 0)          q = p - target;
        if (k === 3 && y < target - 1) q = p + target;
        // 空格是天然断开点：主体轮廓必须在这里止步，否则包边与抠图会连成一片
        if (q < 0 || seg[q] >= 0 || cells[q] === EMPTY) continue;
        const qo = q * 3, po = p * 3;
        // 散布上限（全局）：与区域运行均值的距离——旧版单阈值 0.045 只查这一条，
        // 缓慢渐变上均值跟着漂移，每步局部差都很小，整条渐变会被链式吞成一个区域
        let d0 = srcOk[qo] - mL, d1 = srcOk[qo + 1] - mA, d2 = srcOk[qo + 2] - mB;
        if (d0 * d0 + d1 * d1 + d2 * d2 >= UNIFY_SPREAD * UNIFY_SPREAD) continue;
        // 局部连续：与当前格的源色差——真实边缘两侧差值远超它，即使均值没漂也会断开
        d0 = srcOk[qo] - srcOk[po]; d1 = srcOk[qo + 1] - srcOk[po + 1]; d2 = srcOk[qo + 2] - srcOk[po + 2];
        if (d0 * d0 + d1 * d1 + d2 * d2 >= UNIFY_LOCAL * UNIFY_LOCAL) continue;
        seg[q] = sid; queue[qe++] = q;
      }
    }

    if (mc >= UNIFY_MIN_AREA) {
      const mL = sumL / mc, mA = sumA / mc, mB = sumB / mc;
      const bi = nearestInSet(mL, mA, mB, palIdx);
      if (bi !== EMPTY) for (let m = 0; m < mc; m++) out[members[m]] = bi;
    }
    // mc < UNIFY_MIN_AREA 的格子故意不动 —— 这里正是「源色候选」规则真正生效的地方。
    // 大区域统一后仍会覆盖降采样阶段的逐格决定（实测覆盖 15% 的格子），
    // 所以逐格规则的唯一价值区间就是这些小区域：细线、边角、跨边缘的单格。
    sid++;
  }
  return out;
}

/* ============================================================
   2.7e 导向滤波（技术方案 §2.9，v1.4 的 M2.5）

   动机：§0.5.2 实测平坦区（相邻格源色差 0~10）与边缘（p90 达 56~154）之间隔了一个
   数量级，说明「该平滑哪、该断开哪」可由像素统计直接判定。导向滤波正是这类问题的标准解：
   以原图为引导，方差大处（边缘）保留、方差小处（平坦区）平滑。

   它与平坦区统一的判据本质相同——统一是硬判决（区域增长 + 硬阈值），
   滤波是软加权（局部线性模型）。§0.5.3 实测两者胜负**随素材而变**
   （test.jpg 上滤波碎块 2.55% 优于统一的 3.81%；IMG_3333 上统一 1.11% 优于滤波的 1.89%），
   所以两条都实现，运行时各自自评取优。**不叠加**：叠加已实测为负收益（p50/p90/max 全面劣化）。

   ⚠️ eps 是尺度敏感参数：OKLab 的方差量级与 sRGB 差一个数量级，
   照搬网上 sRGB 教程的 eps（0.01~0.1 的平方量级）会得到完全不同甚至无效的结果。
   改前必须重跑扫描。当前 r=2 / eps=0.04 是 §0.5.3 实测最优档。
   ============================================================ */
let GUIDE_R = 2;
let GUIDE_EPS = 0.04;

/* Box 滤波（可分离，复杂度与半径无关）。src 为 Float32Array(n*3)，返回同形状。 */
function boxFilter3(src, n, w, h, r) {
  const tmp = new Float32Array(n * 3);
  const out = new Float32Array(n * 3);
  // 横向
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let sum = 0, cnt = 0;
      for (let x = -r; x <= r; x++) {
        const xx = x < 0 ? 0 : (x > w - 1 ? w - 1 : x);
        sum += src[(row + xx) * 3 + c]; cnt++;
      }
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 3 + c] = sum / cnt;
        const xa = x - r, xb = x + r + 1;
        const xa2 = xa < 0 ? 0 : (xa > w - 1 ? w - 1 : xa);
        const xb2 = xb < 0 ? 0 : (xb > w - 1 ? w - 1 : xb);
        sum += src[(row + xb2) * 3 + c] - src[(row + xa2) * 3 + c];
      }
    }
  }
  // 纵向
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0, cnt = 0;
      for (let y = -r; y <= r; y++) {
        const yy = y < 0 ? 0 : (y > h - 1 ? h - 1 : y);
        sum += tmp[(yy * w + x) * 3 + c]; cnt++;
      }
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = sum / cnt;
        const ya = y - r, yb = y + r + 1;
        const ya2 = ya < 0 ? 0 : (ya > h - 1 ? h - 1 : ya);
        const yb2 = yb < 0 ? 0 : (yb > h - 1 ? h - 1 : yb);
        sum += tmp[(yb2 * w + x) * 3 + c] - tmp[(ya2 * w + x) * 3 + c];
      }
    }
  }
  return out;
}

/* 单参数版导向滤波（引导图 = 输入图 = 目标网格源色）：
     q = box(a)·guide + box(b)，其中 a = var/(var+eps) → 平坦区趋 0（取局部均值），边缘趋 1（保留）
   返回平滑后的 Float32Array(n*3)。 */
function guidedFilterSelf(src, w, h, r, eps) {
  const n = w * h;
  const sq = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) sq[i] = src[i] * src[i];

  const mean = boxFilter3(src, n, w, h, r);
  const meanSq = boxFilter3(sq, n, w, h, r);

  const a = new Float32Array(n * 3), b = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const varN = meanSq[i] - mean[i] * mean[i];
    const ai = varN / (varN + eps);
    a[i] = ai;
    b[i] = mean[i] - ai * src[i];
  }
  const meanA = boxFilter3(a, n, w, h, r);
  const meanB = boxFilter3(b, n, w, h, r);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = meanA[i] * src[i] + meanB[i];
  return out;
}

/* 择优：把「平坦区统一」与「导向滤波」两条路径各算一遍，用同一套指标评分取优。

   ★★ 实测修正（本轮最重要的发现，推翻了 §0.5.3 的一个结论）★★
   §0.5.3 曾得出「导向滤波在 test.jpg 上全面优于平坦区统一」，但那组数字里
   C 行的误差是**按平滑后的 q 计算的**——正是 §6.7 明确警告的「用目标考核结果」。
   本轮把两种口径都算了一遍（test.jpg 52×52/16 色）：

     方案                                    p50     p90     max     碎块
     A 基线（逐格最近色）                    0.0250  0.0885  0.2652  2.51%
     B 平坦区统一 eps=0.045                  0.0249  0.0707  0.2652  1.04%
     C 导向滤波 r=2/eps=0.04（误差按 q 计）   0.0305  0.0538  0.0755  1.37%
     C 导向滤波（误差按 srcOk 计，正确口径）  0.0449  0.1064  0.2388  0.44%
     D 滤波 + 统一（叠加）                   0.0255  0.0716  0.2388  1.00%

   → **按正确口径，导向滤波的 p90（0.1064）是统一（0.0707）的 1.5 倍**，p50 也明显更差。
     也就是说 §0.5.3 关于「C 优于 B」的判断是自评口径造成的假象：它对真实源色的保真度更差。
     在 test/ 下 6 张素材上复测，滤波路径的 p90 **无一例外**都输给统一（输 19%~58%）。

   但滤波并非一无是处：它的 **max 显著更低**（0.0755 vs 0.2652），碎块也更少（0.44% vs 1.04%）。
   max 低意味着「最脏的那一格没那么脏」，对观感有价值。

   因此评分改为「p90 为主，只有在 max 上取得**大幅**优势时才允许翻盘」，
   避免用小概率的尾部改善去换整体的保真度劣化。

   ★★★ 二次实测修正（IMG_5051 线稿插画暴露的评分盲区，2026-09）★★★
   用户报告：面部被大面积转成源图不存在的青灰（#BCC6B8/#697D80）。插桩定位：
   线稿在 78 格下笔画只占 1~3 格，滤波窗（r=2）内几乎全是边缘，导向滤波的
   逐通道 a 把色度 a 分量与 b 分量抹平成局部均值 → 大面积灰化（面部 273 格中 120 格
   暖粉源色被输出为灰/冷色）。而滤波仍靠 max 优势翻盘获胜——因为跨边缘格的
   srcOk 是黑+粉的「混合均值」（源图不存在），折中灰离它最近，max 恰好被压低。
   三素材实测（78/24 色）：
     路径          p50     p90     max    幻影率(0.04)
     5051 统一    0.0254  0.0990  0.6331  11.3%      ← 滤波 p90 输、幻影率 2.8 倍
     5051 滤波    0.0345  0.1172  0.3100  31.3%      ← 靠 max 翻盘 → 灰化事故
     test.jpg 统一 0.0228 0.0645  0.2969  12.1%
     test.jpg 滤波 0.0382 0.0999 0.2534  23.5%
     3333 统一    0.0172  0.0634  0.5520  15.3%
     3333 滤波    0.0205  0.1049  0.2788  30.6%
   → 滤波的 max 优势与幻影率高度相关（max 低 = 幻影灰多），是口径假象而非观感收益。
     评分加入 PICK_PHANTOM_W × 幻影率后，三素材全部正确选中统一路径。 */
let PICK_P90_W = 1.0;        // p90 主项权重
let PICK_MAX_W = 0.25;       // max 次项权重（刻意压低：实测滤波常在 max 上占优但 p90 明显更差）
let PICK_FRAG_W = 0.4;       // 碎块率权重（量级比误差小一个数量级，故系数放大）
let PICK_PHANTOM_W = 1.0;    // 幻影色率权重（实测滤波靠「max 占优」翻盘、兑现为主观的灰化，见下）

/* 幻影色率：输出色在该格覆盖的真实源色集合（weight ≥ MASTER_EMPTY_W 的主网格格）中找不到
   ≤ PHANTOM_DE 的对应色，即判「幻影格」。这类输出色来自跨边缘格的混合均值（srcOk 对
   这类格是「实际不存在的颜色」），是「离两边都不远不近」的折中灰——ΔE 往哪颗豆都不高，
   于是被 max 敏感的评分当成「安全」选择奖励给滤波路径。
   ⚠️ 只供 chooseConsistency 内部择优，不改 gridMetrics 固定验收口径。 */
const PHANTOM_DE = 0.04;
function phantomRate(cells, target) {
  const step = MASTER / target;
  let bad = 0, tot = 0;
  for (let ty = 0; ty < target; ty++) {
    const y0 = Math.round(ty * step), y1 = Math.round((ty + 1) * step);
    for (let tx = 0; tx < target; tx++) {
      const i = ty * target + tx;
      if (cells[i] === EMPTY) continue;
      tot++;
      const cok = PALETTE[cells[i]].ok;
      const x0 = Math.round(tx * step), x1 = Math.round((tx + 1) * step);
      let best = Infinity;
      for (let y = y0; y < y1; y++) {
        const row = y * MASTER;
        for (let x = x0; x < x1; x++) {
          if (masterW[row + x] < MASTER_EMPTY_W) continue;
          const o = (row + x) * 3;
          const d0 = masterOk[o] - cok[0], d1 = masterOk[o + 1] - cok[1], d2 = masterOk[o + 2] - cok[2];
          const d = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
          if (d < best) best = d;
        }
      }
      if (best > PHANTOM_DE) bad++;
    }
  }
  return tot ? bad / tot : 0;
}

function scoreResult(cells, srcOk, target) {
  const m = gridMetrics(cells, srcOk, target, null);
  const ph = phantomRate(cells, target);
  return {
    score: PICK_P90_W * m.p90 + PICK_MAX_W * m.max + PICK_FRAG_W * m.frag + PICK_PHANTOM_W * ph,
    p90: m.p90, max: m.max, frag: m.frag, phantom: ph, metrics: m
  };
}

/* 在两条空间一致性路径间择优。返回 {cells, pick, detail}。 */
function chooseConsistency(cellsRaw, srcOk, target, palIdx) {
  const t0 = performance.now();
  const c1 = unifyFlatRegions(cellsRaw, srcOk, target, palIdx);
  const t1 = performance.now();
  const q = guidedFilterSelf(srcOk, target, target, GUIDE_R, GUIDE_EPS);
  const t2 = performance.now();
  // 路径 2：按滤波结果重新归属（但评价仍对 srcOk）
  const c2 = new Int16Array(cellsRaw.length);
  for (let i = 0; i < cellsRaw.length; i++) {
    if (cellsRaw[i] === EMPTY) { c2[i] = EMPTY; continue; }
    const o = i * 3;
    c2[i] = nearestInSet(q[o], q[o + 1], q[o + 2], palIdx);
  }
  const s1 = scoreResult(c1, srcOk, target);
  const s2 = scoreResult(c2, srcOk, target);
  const pick = (s1.score <= s2.score) ? 1 : 2;
  return {
    cells: pick === 1 ? c1 : c2,
    pick: pick,
    detail: {
      unify: { p90: s1.p90, max: s1.max, frag: s1.frag, ph: s1.phantom, ms: Math.round(t1 - t0) },
      guided: { p90: s2.p90, max: s2.max, frag: s2.frag, ph: s2.phantom, ms: Math.round(t2 - t1) },
      chosen: pick === 1 ? "统一" : "滤波"
    }
  };
}

/* ============================================================
   2.7c E6 包边 —— 沿主体轮廓「外侧」加一圈 1 格宽的豆子

   需求 Story 6.1 的验收标准里最难的一条是「凹口或细缝处包边保持连续闭合，
   不出现断点」。纯 4 邻接外扩在细缝（比如主体只有 1 格宽的夹角）处会漏掉
   对角线方向的缺口，圈就断了。
   做法：先用 4 邻接精确外扩（保证 1 格宽、不侵入主体），再用 8 邻接补
   那些「外扩后仍与主体对角相邻」的格——只有真的会形成断点时才补，
   所以不会把包边变胖。
   包边网格作为独立一层覆盖在主体之上；它不改 cells，因此「手动改色优先于
   包边」（需求矛盾表第 6 条）天然成立：重算包边不会碰用户改过的格子。
   ============================================================ */
function computeEdgeLayer(cells, target, edgeColorIdx) {
  const n = target * target;
  const layer = new Int16Array(n).fill(EMPTY);
  if (edgeColorIdx === EMPTY) return layer;
  const isBody = new Uint8Array(n);
  let bodyCount = 0;
  for (let i = 0; i < n; i++) if (cells[i] !== EMPTY) { isBody[i] = 1; bodyCount++; }
  if (!bodyCount) return layer;

  // ⚠️ 曾把「外扩」直接写在同一张 target×target 网格上，结果**主体铺满画幅时包边一格都出不来**
  // （实测：78×78 未抠图 → 全格皆主体 → edgeCells = 0，包边功能看起来完全失效）。
  // 原因是包边要加在「主体轮廓的外侧」，而画幅已经满了，外侧不存在。
  // 正解：把判定画在 (target+2)² 的袖珍网格上——四周各留 1 格边距，
  // 这样即便主体铺满原始画幅，最外圈仍有属于包边的位置；写回时丢弃越界部分。
  const T = target + 2;
  const body = new Uint8Array(T * T);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      if (isBody[y * target + x]) body[(y + 1) * T + (x + 1)] = 1;
    }
  }
  const ring = new Int16Array(T * T).fill(EMPTY);

  // 第一轮：4 邻接外扩 —— 主体格的四邻域，且自身不是主体
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const p = y * T + x;
      if (body[p]) continue;
      const up    = y > 0      && body[p - T];
      const down  = y < T - 1  && body[p + T];
      const left  = x > 0      && body[p - 1];
      const right = x < T - 1  && body[p + 1];
      if (up || down || left || right) ring[p] = edgeColorIdx;
    }
  }

  // 第二轮：8 邻接补断点 —— 只补「与主体对角相邻、但四邻接方向没有主体」的格。
  // 这类格正是细缝处 4 邻接漏掉的那一格；补上后包边才闭合。
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const p = y * T + x;
      if (body[p] || ring[p] !== EMPTY) continue;
      let diag = false, orth = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= T) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx; if (xx < 0 || xx >= T) continue;
          if (!body[yy * T + xx]) continue;
          if (dx && dy) diag = true; else orth = true;
        }
      }
      if (diag && !orth) ring[p] = edgeColorIdx;
    }
  }

  // 写回原始画幅：贴在画幅外缘的那一圈包边在图纸上没有对应格，只能丢弃。
  // 这是「主体铺满整幅、没有背景」时不可避免的结果——需求允许这种取舍（包边是给
  // 抠图后的主体加轮廓，主体本来就该有背景留白）。丢弃量会通过 UI 提示告知用户。
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      const v = ring[(y + 1) * T + (x + 1)];
      if (v !== EMPTY) layer[y * target + x] = v;
    }
  }
  return layer;
}

/* 包边层被画幅裁掉了多少格：用于给「主体铺满整幅、无背景」的用户一句明确提示，
   而不是让他看着一圈缺失的包边不明所以。 */
function edgeClippedCount(cells, target, edgeColorIdx) {
  if (edgeColorIdx === EMPTY) return 0;
  const T = target + 2, n = target * target;
  const isBody = new Uint8Array(T * T);
  for (let i = 0; i < n; i++) {
    if (cells[i] === EMPTY) continue;
    const y = (i / target) | 0, x = i - y * target;
    isBody[(y + 1) * T + (x + 1)] = 1;
  }
  let clipped = 0;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const inFrame = y >= 1 && y <= target && x >= 1 && x <= target;
      if (inFrame) continue;
      const p = y * T + x;
      const up = y > 0 && isBody[p - T], down = y < T - 1 && isBody[p + T];
      const left = x > 0 && isBody[p - 1], right = x < T - 1 && isBody[p + 1];
      if (up || down || left || right) clipped++;
    }
  }
  return clipped;
}

/* 包边连通性检查：返回包边层的连通块数与「是否有断口」。
   断口的定义：包边格数量 > 0，但存在与包边 8 邻接的主体格不与任何包边连通——
   这在实际图纸上表现为轮廓某处没被圈住。用于自测与回归。 */
function edgeBreakCount(cells, layer, target) {
  const n = target * target;
  const seen = new Uint8Array(n);
  let blocks = 0;
  for (let s = 0; s < n; s++) {
    if (layer[s] === EMPTY || seen[s]) continue;
    blocks++;
    const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      const y = (p / target) | 0, x = p - y * target;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= target) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= target) continue;
          const q = yy * target + xx;
          if (!seen[q] && layer[q] !== EMPTY) { seen[q] = 1; stack.push(q); }
        }
      }
    }
  }
  return blocks;
}

/* 2.7 图层级验收指标 —— 优化迭代只认数字不认感觉。
   cellErr：每格「源色均值 vs 最终所选色号」的 ΔEOk，取 p50 / p90 / max；
   frag：无意义小碎块占比 = 面积 ≤ FRAG_AREA 的同色连通块中，
   「整块源色均值与外围源色均值差 < FRAG_DE」的格子占比
   （拆并都看不出差别、却增加了换色次数的块，对应 v1.2 的「斑驳」口径）。 */
const FRAG_AREA = 6, FRAG_DE = 0.03;
function gridMetrics(cells, srcOk, target, pal, layer) {
  const n = cells.length;
  // 空格不参与误差统计：它们的「源色」本来就没有意义，算进去会把指标拉偏
  const eff = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    eff[i] = (layer && layer[i] !== EMPTY) ? layer[i] : cells[i];
  }
  const nonEmpty = [];
  for (let i = 0; i < n; i++) if (eff[i] !== EMPTY) nonEmpty.push(i);
  if (!nonEmpty.length) return { p50: 0, p90: 0, max: 0, frag: 0, empty: 1 };

  const errs = new Array(nonEmpty.length);
  for (let k = 0; k < nonEmpty.length; k++) {
    const i = nonEmpty[k];
    const q = i * 3, c = PALETTE[eff[i]].ok;
    const d0 = srcOk[q] - c[0], d1 = srcOk[q + 1] - c[1], d2 = srcOk[q + 2] - c[2];
    errs[k] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  }
  errs.sort(function (a, b) { return a - b; });

  const seen = new Uint8Array(n), stack = new Int32Array(n);
  let fragCells = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s] || eff[s] === EMPTY) continue;
    const id = eff[s];
    let top = 0, cnt = 0;
    stack[top++] = s; seen[s] = 1;
    const comp = [];
    while (top) {
      const p = stack[--top]; comp.push(p); cnt++;
      const y = (p / target) | 0, x = p - y * target;
      for (let k = 0; k < 4; k++) {
        const q2 = k === 0 && x > 0 ? p - 1 : k === 1 && x < target - 1 ? p + 1
          : k === 2 && y > 0 ? p - target : k === 3 && y < target - 1 ? p + target : -1;
        if (q2 < 0 || seen[q2] || eff[q2] !== id) continue;
        seen[q2] = 1; stack[top++] = q2;
      }
    }
    if (cnt > FRAG_AREA) continue;
    let sL = 0, sA = 0, sB = 0;
    for (let m = 0; m < cnt; m++) { const q3 = comp[m] * 3; sL += srcOk[q3]; sA += srcOk[q3 + 1]; sB += srcOk[q3 + 2]; }
    let oL = 0, oA = 0, oB = 0, on = 0;
    for (let m = 0; m < cnt; m++) {
      const p = comp[m], y = (p / target) | 0, x = p - y * target;
      for (let k = 0; k < 4; k++) {
        const q2 = k === 0 && x > 0 ? p - 1 : k === 1 && x < target - 1 ? p + 1
          : k === 2 && y > 0 ? p - target : k === 3 && y < target - 1 ? p + target : -1;
        if (q2 < 0 || eff[q2] === id) continue;
        // 与空格相邻不算「外围源色」：空格没有源色可比，把它算进去会让碎块判定失真
        if (eff[q2] === EMPTY) continue;
        const q3 = q2 * 3; oL += srcOk[q3]; oA += srcOk[q3 + 1]; oB += srcOk[q3 + 2]; on++;
      }
    }
    if (!on) continue;
    const d0 = sL - oL / on, d1 = sA - oA / on, d2 = sB - oB / on;
    if (Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) < FRAG_DE) fragCells += cnt;
  }
  const m = nonEmpty.length;
  return {
    p50: errs[m >> 1],
    p90: errs[Math.min(m - 1, Math.floor(m * 0.9))],
    max: errs[m - 1],
    frag: fragCells / m,
    empty: 1 - m / n
  };
}

