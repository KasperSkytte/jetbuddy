// Small SVG charts: grouped columns, lines, and horizontal bar lists.
// Thin marks, hairline grid, one shared tooltip per x position that also
// works by tapping (phones) and with arrow keys.
import { html, useState, useRef, useLayoutEffect, useEffect } from './lib.js';
import { money, moneyShort } from './fmt.js';
import { t } from './i18n.js';

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Round tick values covering [min, max]. */
export function niceTicks(min, max, count = 4) {
  if (min === max) {
    max = min === 0 ? 1 : min + Math.abs(min);
  }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function extent(series) {
  let min = 0;
  let max = 0;
  for (const s of series) for (const v of s.values) {
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** Path for a column with 4px rounded data-end and a square base. */
function columnPath(x, w, y0, y1) {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return '';
  if (y1 < y0) {
    // grows up
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function Legend({ series, type = 'bar' }) {
  if (series.length < 2) return null;
  return html`<div class="legend">${series.map((s) => html`<span class="item" key=${s.name}>
    <span class=${type === 'line' ? 'ln' : 'sw'} style=${{ background: s.color }}></span>${s.name}</span>`)}</div>`;
}

function Tooltip({ title, rows, x, width, format, extra }) {
  const left = x > width * 0.55 ? Math.max(0, x - 170) : Math.min(x + 14, width - 160);
  return html`<div class="tooltip" style=${{ left: left + 'px', top: '4px' }}>
    <div class="t-title">${title}</div>
    ${rows.map((r) => html`<div class="t-row" key=${r.name}>
      <span class="t-key" style=${{ background: r.color }}></span>
      <span class="t-value">${r.value == null ? '–' : format(r.value)}</span>
      <span class="t-name">${r.name}</span></div>`)}
    ${extra}
  </div>`;
}

/** Shared pointer/keyboard handling: which x index is active. */
function useActive(count, xToIndex) {
  const [active, setActive] = useState(null);
  const handlers = {
    onPointerMove: (e) => {
      if (e.pointerType === 'touch') return;
      const rect = e.currentTarget.getBoundingClientRect();
      setActive(xToIndex(e.clientX - rect.left));
    },
    onPointerLeave: (e) => e.pointerType !== 'touch' && setActive(null),
    onClick: (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const i = xToIndex(e.clientX - rect.left);
      setActive((a) => (a === i ? null : i));
    },
    onKeyDown: (e) => {
      if (e.key === 'ArrowRight') setActive((a) => Math.min(count - 1, a == null ? 0 : a + 1));
      else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, a == null ? count - 1 : a - 1));
      else if (e.key === 'Escape') setActive(null);
      else return;
      e.preventDefault();
    },
    onBlur: () => setActive(null),
  };
  return [active, handlers];
}

/**
 * Grouped columns. series: [{ name, color, values[] }], labels: x labels,
 * titles: longer labels for the tooltip.
 */
export function ColumnChart({ labels, titles, series, height = 220, format = money, tickFormat = moneyShort, label, extraRow }) {
  const [ref, width] = useWidth();
  const n = labels.length;
  const [min, max] = extent(series);
  const ticks = niceTicks(min, max, height < 180 ? 3 : 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const tickLabels = ticks.map(tickFormat);
  const left = Math.max(...tickLabels.map((s) => s.length)) * 6.4 + 8;
  const top = 8;
  const bottom = 22;
  const plotW = Math.max(0, width - left - 2);
  const plotH = height - top - bottom;
  const band = plotW / n;
  const y = (v) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const groupGap = 2;
  const barW = Math.max(2, Math.min(24, (band * 0.72 - groupGap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + groupGap * (series.length - 1);
  const xToIndex = (px) => Math.max(0, Math.min(n - 1, Math.floor((px - left) / band)));
  const [active, handlers] = useActive(n, xToIndex);
  const short = band < 28;

  return html`<div class="chart" ref=${ref} tabindex="0" role="img" aria-label=${label} ...${handlers}>
    ${width > 0 && html`<svg width=${width} height=${height}>
      ${ticks.map((v, i) => html`<g key=${'t' + i}>
        <line class=${v === 0 ? 'baseline' : 'gridline'} x1=${left} x2=${width} y1=${Math.round(y(v)) + 0.5} y2=${Math.round(y(v)) + 0.5} />
        <text class="tick" x=${left - 8} y=${y(v) + 4} text-anchor="end">${tickLabels[i]}</text></g>`)}
      ${active != null && html`<rect class="band-hover" x=${left + active * band} y=${top} width=${band} height=${plotH} rx="6" />`}
      ${labels.map((l, i) => {
        const gx = left + i * band + (band - groupW) / 2;
        return html`<g key=${'g' + i}>
          ${series.map((s, j) => {
            const v = s.values[i];
            if (!v) return null;
            return html`<path key=${j} d=${columnPath(gx + j * (barW + groupGap), barW, y(0), y(v))} fill=${s.color} />`;
          })}
          <text class="tick" x=${left + i * band + band / 2} y=${height - 6} text-anchor="middle" style="text-transform:capitalize">${short ? l.slice(0, 1) : l}</text>
        </g>`;
      })}
    </svg>`}
    ${active != null && html`<${Tooltip} title=${(titles || labels)[active]} x=${left + active * band + band / 2} width=${width} format=${format}
        rows=${series.map((s) => ({ name: s.name, color: s.color, value: s.values[active] }))}
        extra=${extraRow?.(active)} />`}
  </div>`;
}

/** Lines. series: [{ name, color, values[] }]; null values break the line. */
export function LineChart({ labels, titles, series, height = 200, format = money, tickFormat = moneyShort, label, area = false, zero = false }) {
  const [ref, width] = useWidth();
  const n = labels.length;
  let [min, max] = extent(series);
  if (!zero) {
    // Lines don't need a zero baseline; fit the data with some air.
    const vals = series.flatMap((s) => s.values.filter((v) => v != null));
    if (vals.length) {
      min = Math.min(...vals);
      max = Math.max(...vals);
      const pad = (max - min) * 0.1 || Math.abs(max) * 0.1 || 1;
      min -= pad;
      max += pad;
    }
  }
  const ticks = niceTicks(min, max, height < 160 ? 3 : 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const tickLabels = ticks.map(tickFormat);
  const left = Math.max(...tickLabels.map((s) => s.length)) * 6.4 + 8;
  const top = 10;
  const bottom = 22;
  const right = 8;
  const plotW = Math.max(0, width - left - right);
  const plotH = height - top - bottom;
  const x = (i) => left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const xToIndex = (px) => Math.max(0, Math.min(n - 1, Math.round(((px - left) / (plotW || 1)) * (n - 1))));
  const [active, handlers] = useActive(n, xToIndex);
  const step = plotW / Math.max(1, n - 1);
  const every = step < 22 ? Math.ceil(22 / step) : 1;

  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
      pen = true;
    });
    const lastIndex = s.values.reduce((acc, v, i) => (v != null ? i : acc), -1);
    const firstIndex = s.values.findIndex((v) => v != null);
    let areaD = '';
    if (area && lastIndex >= 0) {
      const base = y(Math.max(lo, Math.min(hi, 0)));
      areaD = d + `L${x(lastIndex)},${base}L${x(firstIndex)},${base}Z`;
    }
    return { d, areaD, lastIndex };
  });

  return html`<div class="chart" ref=${ref} tabindex="0" role="img" aria-label=${label} ...${handlers}>
    ${width > 0 && html`<svg width=${width} height=${height}>
      ${ticks.map((v, i) => html`<g key=${'t' + i}>
        <line class=${v === 0 ? 'baseline' : 'gridline'} x1=${left} x2=${width - right} y1=${Math.round(y(v)) + 0.5} y2=${Math.round(y(v)) + 0.5} />
        <text class="tick" x=${left - 8} y=${y(v) + 4} text-anchor="end">${tickLabels[i]}</text></g>`)}
      ${labels.map((l, i) => i % every === 0 && html`<text key=${'x' + i} class="tick" x=${x(i)} y=${height - 6} text-anchor="middle" style="text-transform:capitalize">${step < 28 && typeof l === 'string' ? l.slice(0, 1) : l}</text>`)}
      ${active != null && html`<line class="crosshair" x1=${x(active)} x2=${x(active)} y1=${top} y2=${top + plotH} />`}
      ${series.map((s, j) => html`<g key=${'s' + j}>
        ${area && paths[j].areaD && html`<path d=${paths[j].areaD} fill=${s.color} opacity="0.1" />`}
        <path d=${paths[j].d} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${paths[j].lastIndex >= 0 && active == null && html`<circle cx=${x(paths[j].lastIndex)} cy=${y(s.values[paths[j].lastIndex])} r="4" fill=${s.color} stroke="var(--surface)" stroke-width="2" />`}
        ${active != null && s.values[active] != null && html`<circle cx=${x(active)} cy=${y(s.values[active])} r="4.5" fill=${s.color} stroke="var(--surface)" stroke-width="2" />`}
      </g>`)}
    </svg>`}
    ${active != null && html`<${Tooltip} title=${(titles || labels)[active]} x=${x(active)} width=${width} format=${format}
      rows=${series.map((s) => ({ name: s.name, color: s.color, value: s.values[active] }))} />`}
  </div>`;
}

/** Horizontal bars as HTML rows: label + value on top, bar below. */
export function BarList({ rows, format = money, max }) {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value));
  return html`<div class="bars">${rows.map((r) => html`<div class="bar-row" key=${r.key ?? r.label}>
    <div class="label">${r.color && html`<span class="dot" style=${{ background: r.color }}></span>`}<span>${r.label}</span></div>
    <div class="value">${format(r.value)}${r.sub && html`<small>${r.sub}</small>`}</div>
    <div class="track"><div class="fill" style=${{ width: top > 0 ? Math.max(0, (r.value / top) * 100) + '%' : 0, '--fill': r.color || 'var(--accent)' }}></div></div>
  </div>`)}</div>`;
}

/** A plain table twin of a chart: rows are x labels, columns are series. */
export function ChartTable({ labels, series, format = money, total = true }) {
  return html`<div class="table-scroll"><table class="data">
    <thead><tr><th></th>${series.map((s) => html`<th key=${s.name}>${s.name}</th>`)}</tr></thead>
    <tbody>
      ${labels.map((l, i) => html`<tr key=${i}><td style="text-transform:capitalize">${l}</td>${series.map((s) => html`<td key=${s.name}>${s.values[i] == null ? '–' : format(s.values[i])}</td>`)}</tr>`)}
      ${total && html`<tr class="total"><td></td>${series.map((s) => html`<td key=${s.name}>${format(s.values.reduce((a, v) => a + (v || 0), 0))}</td>`)}</tr>`}
    </tbody>
  </table></div>`;
}

/** Card with a chart/table toggle. */
export function ChartCard({ title, children, table, actions, className = '' }) {
  const [asTable, setAsTable] = useState(false);
  return html`<section class=${'card ' + className}>
    <div class="card-head"><h2>${title}</h2>${actions}
      ${table && html`<button class="btn ghost icon small" onClick=${() => setAsTable(!asTable)}
        aria-pressed=${asTable} title=${asTable ? t('chart.showChart') : t('chart.showTable')} aria-label=${asTable ? t('chart.showChart') : t('chart.showTable')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d=${asTable ? 'M4 4v16h16M8 16v-5M12 16V8M16 16v-3' : 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14'} /></svg></button>`}
    </div>
    ${asTable ? table : children}
  </section>`;
}
