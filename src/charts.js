// رسوم SVG خفيفة بلا مكتبات خارجية — كلها تتلوّن من متغيّرات الثيم.

import { money, monthLabel, num, escapeHTML } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

/** حلقة توزيع المجالات. data = [{label, value, color}] */
export function donut(data, { size = 220, thickness = 34, center } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const rings = data.map((d) => {
    const frac = d.value / total;
    const seg = `<circle class="seg" cx="${c}" cy="${c}" r="${r}" fill="none"
      stroke="${d.color}" stroke-width="${thickness}"
      stroke-dasharray="${(frac * circ).toFixed(2)} ${(circ - frac * circ).toFixed(2)}"
      stroke-dashoffset="${(-offset * circ).toFixed(2)}"
      transform="rotate(-90 ${c} ${c})"><title>${escapeHTML(d.label)}: ${money(d.value)} (${(frac * 100).toFixed(1)}٪)</title></circle>`;
    offset += frac;
    return seg;
  }).join('');
  const mid = center || { top: money(total, { round: true, bare: true }), bottom: 'ريال' };
  return `<svg class="chart donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
    ${rings}
    <text x="${c}" y="${c - 4}" text-anchor="middle" class="donut-top">${escapeHTML(mid.top)}</text>
    <text x="${c}" y="${c + 16}" text-anchor="middle" class="donut-bottom">${escapeHTML(mid.bottom)}</text>
  </svg>`;
}

/** أعمدة أفقية مرتّبة — الأنسب للمجالات لأن الأسماء عربية طويلة. */
export function hbars(data, { max, height = 26, gap = 8, valueFmt = money } = {}) {
  const top = max || Math.max(...data.map((d) => d.value), 1);
  return `<div class="hbars">${data.map((d) => `
    <div class="hbar-row" ${d.onclick ? `data-action="${escapeHTML(d.onclick)}"` : ''}>
      <div class="hbar-label" title="${escapeHTML(d.label)}">${escapeHTML(d.label)}</div>
      <div class="hbar-track" style="height:${height}px">
        <div class="hbar-fill" style="width:${(d.value / top * 100).toFixed(1)}%;background:${d.color || 'var(--accent)'}"></div>
      </div>
      <div class="hbar-value">${valueFmt(d.value)}${d.sub ? `<span class="hbar-sub">${escapeHTML(d.sub)}</span>` : ''}</div>
    </div>`).join('')}</div>`;
}

/** سلسلة شهرية: أعمدة الصرف مع خط الدخل. */
export function monthlyChart(months, { height = 240, incomeSeries = null } = {}) {
  if (!months.length) return '<div class="empty">لا توجد بيانات</div>';
  const w = Math.max(360, months.length * 64);
  const pad = { t: 16, r: 8, b: 34, l: 8 };
  const maxV = Math.max(...months.map((m) => m.spend), ...(incomeSeries || [0])) * 1.1 || 1;
  const bw = (w - pad.l - pad.r) / months.length;
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - v / maxV);

  const bars = months.map((m, i) => {
    const x = pad.l + i * bw + bw * 0.18;
    const bwid = bw * 0.64;
    const h = Math.max(1, height - pad.b - y(m.spend));
    return `<g class="mbar ${m.partial ? 'partial' : ''}">
      <rect x="${x}" y="${y(m.spend)}" width="${bwid}" height="${h}" rx="4"><title>${monthLabel(m.key)}: ${money(m.spend)}</title></rect>
      <text x="${x + bwid / 2}" y="${height - 18}" text-anchor="middle" class="axis">${monthLabel(m.key).split(' ')[0]}</text>
      <text x="${x + bwid / 2}" y="${height - 6}" text-anchor="middle" class="axis dim">${num(m.spend / 1000, 1)}ك</text>
    </g>`;
  }).join('');

  let line = '';
  if (incomeSeries && incomeSeries.length === months.length) {
    const pts = incomeSeries.map((v, i) => `${pad.l + i * bw + bw / 2},${y(v)}`).join(' ');
    line = `<polyline class="income-line" points="${pts}" fill="none" />` +
      incomeSeries.map((v, i) => `<circle class="income-dot" cx="${pad.l + i * bw + bw / 2}" cy="${y(v)}" r="3"><title>دخل ${monthLabel(months[i].key)}: ${money(v)}</title></circle>`).join('');
  }
  return `<div class="chart-scroll"><svg class="chart monthly" viewBox="0 0 ${w} ${height}" width="${w}" height="${height}">${bars}${line}</svg></div>`;
}

/** شريط تكديس بسيط لمجموعات الإنفاق (ملتزم / مرن / غامض). */
export function stackedBar(parts, { height = 26 } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return `<div class="stacked" style="height:${height}px">${parts.map((p) => `
    <div class="stacked-seg" style="width:${(p.value / total * 100).toFixed(2)}%;background:${p.color}" title="${escapeHTML(p.label)}: ${money(p.value)}">
      <span>${(p.value / total * 100) >= 9 ? escapeHTML(p.label) : ''}</span>
    </div>`).join('')}</div>`;
}

/** مؤشّر نصف دائري لدرجة الأريحية. */
export function gauge(score, { size = 180, label = '' } = {}) {
  const r = size / 2 - 16;
  const c = size / 2;
  const a = Math.PI * (1 - Math.min(100, Math.max(0, score)) / 100);
  const x = c + r * Math.cos(a), y = c - r * Math.sin(a) + 10;
  const arc = (from, to, color, wdt = 14) => {
    const a1 = Math.PI * (1 - from / 100), a2 = Math.PI * (1 - to / 100);
    const x1 = c + r * Math.cos(a1), y1 = c - r * Math.sin(a1) + 10;
    const x2 = c + r * Math.cos(a2), y2 = c - r * Math.sin(a2) + 10;
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}" stroke="${color}" stroke-width="${wdt}" fill="none" stroke-linecap="round"/>`;
  };
  return `<svg class="chart gauge" viewBox="0 0 ${size} ${size * 0.85}" width="${size}" height="${size * 0.85}">
    ${arc(0, 45, 'var(--danger-soft)')}
    ${arc(45, 70, 'var(--warn-soft)')}
    ${arc(70, 100, 'var(--ok-soft)')}
    <line x1="${c}" y1="${c + 10}" x2="${x}" y2="${y}" stroke="var(--fg)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${c}" cy="${c + 10}" r="5" fill="var(--fg)"/>
    <text x="${c}" y="${c + 34}" text-anchor="middle" class="gauge-score">${num(score)}</text>
    <text x="${c}" y="${c + 50}" text-anchor="middle" class="gauge-label">${escapeHTML(label)}</text>
  </svg>`;
}

/** خط صغير داخل الجداول. */
export function sparkline(values, { width = 90, height = 24, color = 'var(--accent)' } = {}) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / span) * (height - 4) - 2}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}

export { NS };
