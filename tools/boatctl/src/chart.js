'use strict';

/**
 * 极简 SVG 折线图生成器（零依赖、无 CDN）。
 *
 * 为什么要自己写：比赛现场可能没网，任何依赖 CDN 的图表库都会开天窗。
 * 输出的 SVG 直接内联进 HTML，单文件可离线打开、可打印成 PDF。
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function niceStep(range, targetTicks) {
  const raw = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function ticks(min, max, targetTicks = 5) {
  const step = niceStep((max - min) || 1, targetTicks);
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(+v.toFixed(6));
  return out;
}

const fmtTick = (v) => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (Number.isInteger(v)) return String(v);
  if (a >= 1000) return String(Math.round(v));
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(2);
};

/**
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {Array}  o.series  [{ name, color, points:[[x,y],...], width?, dash?, shape? }]
 * @param {Array}  o.bands   [{ y0, y1, color }] 水平色带（例如 ±10° 容差带）
 * @param {Array}  o.hlines  [{ y, color, dash, label }]
 * @param {number} o.xMin / o.xMax / o.yMin / o.yMax
 * @param {string} o.xLabel / o.yLabel / o.title
 */
function lineChart(o) {
  const width = o.width || 760;
  const height = o.height || 260;
  const pad = Object.assign({ l: 56, r: 16, t: 26, b: 44 }, o.pad || {});
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const pts = (o.series || []).flatMap((s) => s.points || []);
  if (!pts.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="60"><text x="8" y="30" font-size="13" fill="#888">无数据</text></svg>';

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let xMin = o.xMin !== undefined ? o.xMin : Math.min(...xs);
  let xMax = o.xMax !== undefined ? o.xMax : Math.max(...xs);
  let yMin = o.yMin !== undefined ? o.yMin : Math.min(...ys);
  let yMax = o.yMax !== undefined ? o.yMax : Math.max(...ys);
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.12;
  if (o.yMin === undefined) yMin -= yPad;
  if (o.yMax === undefined) yMax += yPad;

  const sx = (x) => pad.l + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y) => pad.t + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  const out = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" font-family="-apple-system,Segoe UI,Noto Sans SC,sans-serif">');
  out.push('<rect width="' + width + '" height="' + height + '" fill="#ffffff"/>');

  if (o.title) out.push('<text x="' + pad.l + '" y="17" font-size="13" font-weight="600" fill="#333">' + esc(o.title) + '</text>');

  // 水平色带
  for (const b of o.bands || []) {
    const y0 = Math.max(yMin, Math.min(b.y0, b.y1));
    const y1 = Math.min(yMax, Math.max(b.y0, b.y1));
    if (y1 <= y0) continue;
    out.push('<rect x="' + pad.l + '" y="' + sy(y1).toFixed(2) + '" width="' + plotW + '" height="' + (sy(y0) - sy(y1)).toFixed(2) + '" fill="' + b.color + '"/>');
  }

  // 网格与刻度
  for (const v of ticks(yMin, yMax, 4)) {
    const y = sy(v).toFixed(2);
    out.push('<line x1="' + pad.l + '" y1="' + y + '" x2="' + (pad.l + plotW) + '" y2="' + y + '" stroke="#e8e8e8" stroke-width="1"/>');
    out.push('<text x="' + (pad.l - 8) + '" y="' + (Number(y) + 4).toFixed(2) + '" font-size="11" fill="#777" text-anchor="end">' + fmtTick(v) + '</text>');
  }
  for (const v of ticks(xMin, xMax, 6)) {
    const x = sx(v).toFixed(2);
    out.push('<line x1="' + x + '" y1="' + pad.t + '" x2="' + x + '" y2="' + (pad.t + plotH) + '" stroke="#f2f2f2" stroke-width="1"/>');
    out.push('<text x="' + x + '" y="' + (pad.t + plotH + 16) + '" font-size="11" fill="#777" text-anchor="middle">' + fmtTick(v) + '</text>');
  }

  // 参考横线
  for (const h of o.hlines || []) {
    if (h.y < yMin || h.y > yMax) continue;
    const y = sy(h.y).toFixed(2);
    out.push('<line x1="' + pad.l + '" y1="' + y + '" x2="' + (pad.l + plotW) + '" y2="' + y + '" stroke="' + (h.color || '#bbb') + '" stroke-width="1" stroke-dasharray="' + (h.dash || '4 4') + '"/>');
    if (h.label) out.push('<text x="' + (pad.l + plotW - 4) + '" y="' + (Number(y) - 4).toFixed(2) + '" font-size="10" fill="' + (h.color || '#999') + '" text-anchor="end">' + esc(h.label) + '</text>');
  }

  // 坐标轴
  out.push('<line x1="' + pad.l + '" y1="' + pad.t + '" x2="' + pad.l + '" y2="' + (pad.t + plotH) + '" stroke="#ccc"/>');
  out.push('<line x1="' + pad.l + '" y1="' + (pad.t + plotH) + '" x2="' + (pad.l + plotW) + '" y2="' + (pad.t + plotH) + '" stroke="#ccc"/>');

  // 数据线
  for (const s of o.series || []) {
    const p = s.points || [];
    if (!p.length) continue;
    if (s.shape === 'dot') {
      for (const [x, y] of p) out.push('<circle cx="' + sx(x).toFixed(2) + '" cy="' + sy(y).toFixed(2) + '" r="2.2" fill="' + s.color + '"/>');
    } else {
      const d = p.map(([x, y], i) => (i ? 'L' : 'M') + sx(x).toFixed(2) + ' ' + sy(y).toFixed(2)).join(' ');
      out.push('<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 2) + '"'
        + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '')
        + ' stroke-linejoin="round" stroke-linecap="round"/>');
    }
  }

  // 图例
  if (o.series && o.series.length) {
    let lx = pad.l;
    const ly = height - 8;
    for (const s of o.series) {
      if (!s.name) continue;
      out.push('<line x1="' + lx + '" y1="' + (ly - 4) + '" x2="' + (lx + 16) + '" y2="' + (ly - 4) + '" stroke="' + s.color + '" stroke-width="' + (s.width || 2) + '"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + '/>');
      out.push('<text x="' + (lx + 21) + '" y="' + ly + '" font-size="11" fill="#555">' + esc(s.name) + '</text>');
      lx += 21 + String(s.name).length * 11 + 18;
    }
  }

  if (o.xLabel) out.push('<text x="' + (pad.l + plotW) + '" y="' + (height - 8) + '" font-size="11" fill="#999" text-anchor="end">' + esc(o.xLabel) + '</text>');

  out.push('</svg>');
  return out.join('');
}

module.exports = { lineChart, esc };
