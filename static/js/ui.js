// Small shared components: icons, modal sheet, toasts, amount input, chips.
import { html, useState, useEffect, useRef, render } from './lib.js';
import { amount, parseAmount } from './fmt.js';
import { t } from './i18n.js';

// ------------------------------------------------------------------ icons
// 24x24 stroke icons, drawn for this app.
const PATHS = {
  overview: 'M4 13h4v7H4zM10 4h4v16h-4zM16 9h4v11h-4z',
  month: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M8 3v4M16 3v4M8 14h2M12 14h2M16 14h0M8 17h2',
  plan: 'M4 5h16M4 10h16M4 15h10M4 20h7M18 15v6M15 18h6',
  trends: 'M3 17l5-5 4 4 8-9M14 7h6v6',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.5 7.5 0 0 1-2 1.2L14.8 21h-3.9l-.3-2.4a7.5 7.5 0 0 1-2-1.2l-2 .7-2-3.4 1.7-1.2a7.6 7.6 0 0 1 0-2.4L4.6 9.9l2-3.4 2 .7a7.5 7.5 0 0 1 2-1.2L10.9 3h3.9l.3 2.4a7.5 7.5 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 0 1 0 2.4z',
  plus: 'M12 5v14M5 12h14',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  repeat: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  note: 'M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 18.5 8H6.5A2.5 2.5 0 0 1 4 5.5M16 13.5h1',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  chart: 'M4 4v16h16M8 16v-5M12 16V8M16 16v-3',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  egg: 'M12 3c3.6 0 6.5 5.4 6.5 10a6.5 6.5 0 0 1-13 0C5.5 8.4 8.4 3 12 3z',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14a6.5 6.5 0 0 1 3 6',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9zM8 8h.01',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
};

export function Icon({ name, size = 22, stroke = 1.8 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d=${PATHS[name] || ''} /></svg>`;
}

export function Logo({ size = 34 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="16" fill="var(--accent)" />
    <path d="M32 13c8.3 0 15 12.2 15 22.5a15 15 0 0 1-30 0C17 25.2 23.7 13 32 13z" fill="#fff" />
    <path d="M24.5 38.5h15M27 44h10" stroke="var(--accent)" stroke-width="3.2" stroke-linecap="round" />
  </svg>`;
}

// ------------------------------------------------------------------ colors

export const seriesColor = (i) => `var(--s${((i ?? 0) % 8) + 1})`;

export function Dot({ color, size = 10 }) {
  return html`<span class="dot" style=${{ background: color, width: size + 'px', height: size + 'px' }}></span>`;
}

// ------------------------------------------------------------------ toast

let toastRoot = null;
let toasts = [];
function renderToasts() {
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    document.body.appendChild(toastRoot);
  }
  render(html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((m) => html`<div key=${m.id} class=${'toast' + (m.error ? ' error' : '')}>${m.text}</div>`)}
  </div>`, toastRoot);
}
export function toast(text, { error = false } = {}) {
  const id = Math.random();
  toasts = [...toasts, { id, text, error }];
  renderToasts();
  setTimeout(() => {
    toasts = toasts.filter((m) => m.id !== id);
    renderToasts();
  }, error ? 5000 : 2600);
}
export function toastError(e) {
  const msg = e?.message === 'offline' ? t('error.offline') : e?.message || String(e);
  toast(msg, { error: true });
}

// ------------------------------------------------------------------ modal sheet

/** Bottom sheet on phones, centered dialog on wider screens. */
export function Sheet({ title, onClose, children, footer, wide = false }) {
  const panel = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current?.querySelector('[autofocus]');
    if (first && matchMedia('(pointer: fine)').matches) first.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);
  return html`
    <div class="scrim" onClick=${onClose}></div>
    <div class=${'sheet-panel' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label=${title} ref=${panel}>
      <div class="grabber"></div>
      <div class="sheet-head">
        <h2>${title}</h2>
        <button class="btn ghost icon" onClick=${onClose} aria-label=${t('common.close')}><${Icon} name="close" /></button>
      </div>
      <div class="sheet-body">${children}</div>
      ${footer && html`<div class="sheet-foot">${footer}</div>`}
    </div>`;
}

// ------------------------------------------------------------------ amount input

/**
 * A text box for money. Shows the formatted value, edits the raw one, saves
 * on blur or Enter (which also moves to the next box, so a column of amounts
 * can be typed in one go).
 */
export function AmountInput({ value, onSave, placeholder = '–', className = 'amount-input', label, manual = false, autoFocus = false }) {
  const [text, setText] = useState(amount(value));
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState(''); // '', 'saved', 'invalid'
  const dirty = useRef(false); // only typed-in changes are saved
  const ref = useRef(null);
  useEffect(() => {
    if (!focused) setText(amount(value));
  }, [value, focused]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);

  const commit = async () => {
    if (!dirty.current) {
      setText(amount(value));
      return;
    }
    dirty.current = false;
    const parsed = parseAmount(text);
    if (Number.isNaN(parsed)) {
      dirty.current = true;
      setState('invalid');
      return;
    }
    setText(amount(parsed));
    if (parsed === (value ?? null)) {
      setState('');
      return;
    }
    try {
      await onSave(parsed);
      setState('saved');
      setTimeout(() => setState(''), 900);
    } catch (e) {
      setText(amount(value));
      setState('invalid');
      toastError(e);
    }
  };

  const keydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusNext(e.target, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      dirty.current = false;
      setText(amount(value));
      e.target.blur();
    }
  };

  return html`<input ref=${ref} class=${[className, state, manual ? 'manual' : ''].join(' ')}
    type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off"
    aria-label=${label} placeholder=${placeholder} value=${text}
    onFocus=${(e) => { setFocused(true); setState(''); requestAnimationFrame(() => e.target.select()); }}
    onBlur=${() => { setFocused(false); commit(); }}
    onInput=${(e) => { dirty.current = true; setText(e.target.value); }}
    onKeyDown=${keydown} />`;
}

/** Move focus to the next/previous amount box in the page, or blur at the end. */
export function focusNext(el, dir = 1) {
  const all = [...document.querySelectorAll('input[inputmode="decimal"]')].filter((x) => x.offsetParent);
  const i = all.indexOf(el);
  const next = all[i + dir];
  if (next) next.focus();
  else el.blur();
}

// ------------------------------------------------------------------ misc

export function Chips({ options, value, onChange, label }) {
  return html`<div class="chips" role="tablist" aria-label=${label}>
    ${options.map((o) => html`<button key=${o.value} role="tab" aria-selected=${o.value === value}
        class=${'chip' + (o.value === value ? ' active' : '')} onClick=${() => onChange(o.value)}>
      ${o.color && html`<${Dot} color=${o.color} />`}${o.label}</button>`)}
  </div>`;
}

export function Segmented({ options, value, onChange, label }) {
  return html`<div class="segmented" role="radiogroup" aria-label=${label}>
    ${options.map((o) => html`<button key=${o.value} type="button" role="radio" aria-checked=${o.value === value}
      class=${o.value === value ? 'active' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

export function Switch({ checked, onChange, label, hint }) {
  return html`<label class="switch">
    <span class="text">${label}${hint && html`<div class="hint small muted">${hint}</div>`}</span>
    <input type="checkbox" role="switch" checked=${checked} onChange=${(e) => onChange(e.target.checked)} />
  </label>`;
}

export function Swatches({ value, onChange }) {
  return html`<div class="swatches" role="radiogroup" aria-label=${t('common.color')}>
    ${Array.from({ length: 8 }, (_, i) => html`<button type="button" role="radio" aria-checked=${i === value}
      aria-label=${t('common.color') + ' ' + (i + 1)} class=${i === value ? 'active' : ''}
      style=${{ background: seriesColor(i) }} onClick=${() => onChange(i)}></button>`)}
  </div>`;
}

export function YearStepper({ year, onChange }) {
  return html`<div class="year-stepper">
    <button onClick=${() => onChange(year - 1)} aria-label=${t('common.prevYear')}><${Icon} name="left" size=${18} /></button>
    <span class="value">${year}</span>
    <button onClick=${() => onChange(year + 1)} aria-label=${t('common.nextYear')}><${Icon} name="right" size=${18} /></button>
  </div>`;
}

export function Empty({ title, children }) {
  return html`<div class="empty"><div class="big">${title}</div>${children}</div>`;
}
