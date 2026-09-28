"use strict";
/* ============================================================
   3. 渲染：A 网格图纸 + B 色卡集合版
   ============================================================ */
const CELL = 40;                 // 每格 40px（方案 Q14）
const PAD = 44;
const GAP = 56;
const CARD_W = 168, CARD_H = 104, CARD_GAP = 12, CARD_COLS = 8;

function textColorOn(r, g, b) {
  const L = 0.2126 * SRGB_LIN[r] + 0.7152 * SRGB_LIN[g] + 0.0722 * SRGB_LIN[b];
  return L > 0.179 ? "#1a1a1a" : "#ffffff";
}

/* 「空」格的画法：不填色，改成浅灰底的斜纹 + 空心底 —— 一眼可辨「这里不放豆」，
   与任何色卡色的实心格都不会混。 */
function drawEmptyCell(ctx, px, py, size) {
  ctx.fillStyle = "#FBFAF7";
  ctx.fillRect(px, py, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, size, size);
  ctx.clip();
  ctx.strokeStyle = "rgba(120,114,104,.30)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let d = -size; d < size * 2; d += 9) {
    ctx.moveTo(px + d, py);
    ctx.lineTo(px + d + size, py + size);
  }
  ctx.stroke();
  ctx.restore();
}

/* 用量统计：排除空格（需求 Story 5.1 假设 4 —— 空格不计数、不计入用量清单）。
   包边层单独统计，因为它不属于 cells，但需求 Story 6.1 要求它「计入用量清单」。 */
function tallyUsage(cells, layer) {
  const counts = new Int32Array(PALETTE.length);
  let placed = 0, empty = 0, edgeCount = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === EMPTY) empty++;
    else { counts[cells[i]]++; placed++; }
  }
  if (layer) {
    for (let i = 0; i < layer.length; i++) {
      if (layer[i] === EMPTY) continue;
      counts[layer[i]]++; edgeCount++;
    }
  }
  const used = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] > 0) used.push({ pi: i, n: counts[i] });
  used.sort(function (a, b) { return b.n - a.n || (a.pi - b.pi); });
  return { used: used, placed: placed, empty: empty, edge: edgeCount, total: placed + edgeCount };
}

/* render(cells, target, layer, sel, opts)
   opts.exportScale —— 导出时按此倍率放大每格像素（相对屏幕预览的 CELL），
   使同一套绘制逻辑既能画预览也能画「每格 40px」的导出图，不需要两份代码。
   opts.sel —— 选中态叠加层（Uint8Array），仅预览时传。 */
function render(cells, target, layer, sel, ctx, opts) {
  const o = opts || {};
  const cell = o.cell || CELL;
  const S = cell / CELL;                        // 相对基准的字号缩放
  const fs = Math.round(cell * 0.36);
  const gridPx = target * cell;
  const pad = Math.round(PAD * S);
  const gap = Math.round(GAP * S);
  const cardW = Math.round(CARD_W * S), cardH = Math.round(CARD_H * S);
  const cardGap = Math.round(CARD_GAP * S);
  const cardCols = o.cardCols || CARD_COLS;

  const usage = tallyUsage(cells, layer);
  const used = usage.used;

  const cardRows = Math.max(1, Math.ceil(used.length / cardCols));
  const legendTitleH = Math.round(34 * S);
  const legendW = cardCols * cardW + (cardCols - 1) * cardGap;
  const legendH = legendTitleH + cardRows * (cardH + cardGap) - cardGap;

  const W = Math.max(gridPx, legendW) + pad * 2;
  const H = pad + gridPx + gap + legendH + pad;

  const cv = ctx.canvas;
  cv.width = W; cv.height = H;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const gx0 = pad, gy0 = pad;

  // --- A. 网格图纸 ---
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      const i = y * target + x;
      const e = layer && layer[i] !== EMPTY ? layer[i] : cells[i];
      const px = gx0 + x * cell, py = gy0 + y * cell;
      if (e === EMPTY) {
        if (S < 0.5) {
          // 导出小尺寸时斜纹会变成噪点，空格改用纯浅灰
          ctx.fillStyle = "#FAF8F5";
          ctx.fillRect(px, py, cell, cell);
        } else {
          drawEmptyCell(ctx, px, py, cell);
        }
        continue;
      }
      const c = PALETTE[e];
      ctx.fillStyle = c.hex;
      ctx.fillRect(px, py, cell, cell);
      ctx.fillStyle = textColorOn(c.rgb[0], c.rgb[1], c.rgb[2]);
      ctx.font = "500 " + fs + "px ui-monospace,SFMono-Regular,Menlo,monospace";
      ctx.fillText(c.code, px + cell / 2, py + cell / 2 + 0.5 * S);
    }
  }

  // 网格线
  ctx.strokeStyle = "rgba(0,0,0,.14)";
  ctx.lineWidth = Math.max(1, Math.round(S));
  ctx.beginPath();
  for (let x = 0; x <= target; x++) {
    const px = gx0 + x * cell + 0.5;
    ctx.moveTo(px, gy0); ctx.lineTo(px, gy0 + gridPx);
  }
  for (let y = 0; y <= target; y++) {
    const py = gy0 + y * cell + 0.5;
    ctx.moveTo(gx0, py); ctx.lineTo(gx0 + gridPx, py);
  }
  ctx.stroke();

  // 每 10 格一条参考线（方便数格子）：四周先空出对称边距（52→空 1 格、
  // 78→空 4 格、104→空 2 格），分段即为 1、10、…、10、1：边界在
  // gm、gm+10、…、gLast 处（含最外侧两条边界线）。
  // 辅助线贯穿整张网格——每条线从一边的外框一直画到对边外框，越过边距带；
  // 每段的第 5 格位置再用浅色虚线作半程参照（实线与虚线延伸范围一致）。
  const gm = Math.floor((target % 10) / 2);      // 对称边距（格数）
  const gLast = target - gm;                     // 最外一条辅助线的边界位置
  function drawGuide(dir) {
    if (target < 10) return;
    const lo = 0, hi = gridPx;                   // 贯穿整张网格（0 → target 格）
    const xAt = (g) => gx0 + (dir === "x" ? g * cell : lo) + 0.5;
    const yAt = (g) => gy0 + (dir === "x" ? lo : g * cell) + 0.5;
    const spanTo = (g) => dir === "x"
      ? [xAt(g), gy0 + lo, xAt(g), gy0 + hi]
      : [gx0 + lo, yAt(g), gx0 + hi, yAt(g)];
    ctx.lineWidth = Math.max(2, Math.round(2 * S));
    ctx.strokeStyle = "#000000";
    ctx.beginPath();
    for (let g = gm; g <= gLast; g += 10) {
      const s = spanTo(g);
      ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]);
    }
    ctx.stroke();
    ctx.save();
    ctx.lineWidth = Math.max(1, Math.round(1.4 * S));
    ctx.strokeStyle = "rgba(0,0,0,.28)";
    ctx.setLineDash([5 * S, 4 * S]);
    ctx.beginPath();
    for (let g = gm + 5; g < gLast; g += 10) {
      const s = spanTo(g);
      ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]);
    }
    ctx.stroke();
    ctx.restore();
  }
  drawGuide("x");
  drawGuide("y");

  // 选中高亮（仅预览）：朱红描边 + 半透明填充，保证压在任意豆色上都看得见
  if (sel) {
    ctx.save();
    ctx.lineWidth = Math.max(2, Math.round(2.4 * S));
    ctx.strokeStyle = "#C8452A";
    ctx.fillStyle = "rgba(200,69,42,.22)";
    ctx.beginPath();
    for (let i = 0; i < sel.length; i++) {
      if (!sel[i]) continue;
      const y = (i / target) | 0, x = i - y * target;
      const px = gx0 + x * cell, py = gy0 + y * cell;
      ctx.rect(px + 1, py + 1, cell - 2, cell - 2);
    }
    ctx.fill();
    ctx.stroke();
    // 逐格再描一圈，避免相邻选中格被合并成一大块而看不出格界
    ctx.lineWidth = Math.max(1, Math.round(1.2 * S));
    ctx.strokeStyle = "rgba(157,53,32,.75)";
    ctx.beginPath();
    for (let i = 0; i < sel.length; i++) {
      if (!sel[i]) continue;
      const y = (i / target) | 0, x = i - y * target;
      ctx.rect(gx0 + x * cell + 1, gy0 + y * cell + 1, cell - 2, cell - 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 未确认改动的可见标记（需求 §2.5.5：被改的格子以可见方式标记）：深红虚线描边，
  // 与「选中高亮」（朱红实线）区分。仅在改色会话中出现，确认/取消后消失。
  if (o.draft) {
    ctx.save();
    ctx.setLineDash([4 * S, 3 * S]);
    ctx.lineWidth = Math.max(2, Math.round(2.2 * S));
    ctx.strokeStyle = "#9D3520";
    ctx.beginPath();
    for (let i = 0; i < o.draft.length; i++) {
      if (!o.draft[i]) continue;
      const y = (i / target) | 0, x = i - y * target;
      ctx.rect(gx0 + x * cell + 1, gy0 + y * cell + 1, cell - 2, cell - 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 外框
  ctx.strokeStyle = "rgba(0,0,0,.55)";
  ctx.lineWidth = Math.max(2, Math.round(2 * S));
  ctx.strokeRect(gx0 + 0.5, gy0 + 0.5, gridPx, gridPx);

  // --- B. 色卡集合版 ---
  const ly0 = gy0 + gridPx + gap;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#C8452A";
  ctx.fillRect(gx0, ly0 + 2 * S, 32 * S, 3 * S);
  ctx.fillStyle = "#1E1C19";
  ctx.font = "600 " + Math.round(16 * S) + "px Georgia,'Songti SC','Noto Serif SC',serif";
  ctx.fillText("色卡集合版", gx0, ly0 + 28 * S);
  const tw = ctx.measureText("色卡集合版").width;
  ctx.fillStyle = "#6C6860";
  ctx.font = "400 " + Math.round(13 * S) + "px ui-monospace,SFMono-Regular,Menlo,monospace";
  const edgeNote = usage.edge ? " · 含包边 " + usage.edge : "";
  const note = "共 " + used.length + " 色 · " + usage.total + " 颗" +
    (usage.empty ? " · 空 " + usage.empty + " 格" : "") + edgeNote;
  ctx.fillText(note, gx0 + tw + 12 * S, ly0 + 28 * S);
  ctx.textBaseline = "middle";

  const total = usage.total || 1;
  for (let i = 0; i < used.length; i++) {
    const col = i % cardCols, row = Math.floor(i / cardCols);
    const cx = gx0 + col * (cardW + cardGap);
    const cy = ly0 + legendTitleH + row * (cardH + cardGap);
    const c = PALETTE[used[i].pi];

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rr = 8 * S;
    if (ctx.roundRect) ctx.roundRect(cx + 0.5, cy + 0.5, cardW - 1, cardH - 1, rr);
    else ctx.rect(cx + 0.5, cy + 0.5, cardW - 1, cardH - 1);
    ctx.fill(); ctx.stroke();

    const bw = cardW - 24 * S, bh = 50 * S;
    ctx.fillStyle = c.hex;
    ctx.fillRect(cx + 12 * S, cy + 10 * S, bw, bh);
    ctx.strokeStyle = "rgba(0,0,0,.12)";
    ctx.strokeRect(cx + 12 * S + 0.5, cy + 10 * S + 0.5, bw - 1, bh - 1);

    ctx.textAlign = "left";
    ctx.fillStyle = "#2c2c2a";
    ctx.font = "600 " + Math.round(20 * S) + "px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.fillText(c.code, cx + 12 * S, cy + 82 * S);

    ctx.fillStyle = "#6f6d68";
    ctx.font = "400 " + Math.round(12.5 * S) + "px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif";
    ctx.fillText(used[i].n + " 颗 · " + (used[i].n / total * 100).toFixed(1) + "%", cx + 12 * S, cy + 96 * S);

    ctx.textAlign = "right";
    ctx.fillStyle = "#a9a7a1";
    ctx.font = "400 " + Math.round(11 * S) + "px ui-monospace,SFMono-Regular,Menlo,monospace";
    ctx.fillText(c.hex.toUpperCase(), cx + cardW - 12 * S, cy + 96 * S);
  }

  return { used: used, W: W, H: H, gridPx: gridPx, cell: cell, pad: pad, usage: usage };
}

/* 3.3 回归自评钩子 —— 供无头脚本调用，把「当前这次转换」的全部可量化事实
   一次性吐出来。技术方案要求「改阈值/加机制前先留基线，用同一套指标对比」，
   这个钩子就是那套指标的取数口子；有它才能自动跑回归，而不是靠肉眼。
   注意：这里刻意不依赖任何调试期全局变量（那些在正式代码里不存在），
   全部数据都来自 lastResult 这个正式产物。 */
window.MARD_SELFEVAL = function () {
  if (!lastResult) return null;
  const r = lastResult;
  const m = r.metrics;
  let empty = 0, placed = 0, blackCells = 0;
  for (let i = 0; i < r.cells.length; i++) {
    const c = r.cells[i];
    if (c === EMPTY) { empty++; continue; }
    placed++;
    if (PALETTE[c].code === "H7") blackCells++;
  }
  // 空格（不参与转换的格）占比过高的告警：说明抠图/裁剪把内容砍太多
  return {
    target: r.target,
    requestedN: state.N,
    poolSize: r.poolLen || 0,
    usedColors: r.meta.used.length,
    placed: placed,
    empty: empty,
    emptyRatio: +(empty / r.cells.length).toFixed(4),
    blackCells: blackCells,
    edgeCells: r.meta.usage.edge,
    edgeColor: refine.edge === EMPTY ? null : PALETTE[refine.edge].code,
    outline: refine.outlineOn ? {
      color: PALETTE[refine.outlineColor].code,
      cells: refine._outlineCells ? refine._outlineCells.reduce(function (a, b) { return a + b; }, 0) : 0
    } : null,
    crop: refine.crop ? { x: refine.crop.x, y: refine.crop.y, w: refine.crop.w, h: refine.crop.h } : null,
    hasMask: !!refine.mask,
    manualCells: countManual(),
    p50: +m.p50.toFixed(4),
    p90: +m.p90.toFixed(4),
    max: +m.max.toFixed(4),
    frag: +m.frag.toFixed(4),
    struct: r.struct ? {
      edgeRecall: +r.struct.edgeRecall.toFixed(4),
      edgeExtra: +r.struct.edgeExtra.toFixed(4),
      featRecall: +r.struct.featRecall.toFixed(4),
      srcEdges: r.struct.srcEdges,
      outEdges: r.struct.outEdges,
      feats: r.struct.feats
    } : null,
    consistency: lastConsist,
    canvasW: cv.width,
    canvasH: cv.height,
    cellPx: r.meta.cell,
    usedCodes: r.meta.used.map(function (u) { return PALETTE[u.pi].code; })
  };
};

/* 3.4 包边自测：返回包边层的连通块数（>1 说明轮廓某处没被圈住） */
window.MARD_EDGE_CHECK = function () {
  if (!lastResult || refine.edge === EMPTY) return null;
  const t = lastResult.target;
  const layer = computeEdgeLayer(lastResult.cells, t, refine.edge);
  let n = 0;
  for (let i = 0; i < layer.length; i++) if (layer[i] !== EMPTY) n++;
  return { edgeCells: n, blocks: edgeBreakCount(lastResult.cells, layer, t) };
};
