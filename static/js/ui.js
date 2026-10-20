// Small shared components: icons, modal sheet, toasts, amount input, chips.
import { html, useState, useEffect, useRef, render } from './lib.js';
import { useStore, setStore } from './store.js';
import { amountText, parseTyped, hasDecimals, cleanTyped, amountInputMode } from './fmt.js';
import { t, has } from './i18n.js';

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
  home: 'M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  share: 'M12 3v12M8 7l4-4 4 4M7 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H17',
  addSquare: 'M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4zM12 8.5v7M8.5 12h7',
  dots: 'M12 5.5v.01M12 12v.01M12 18.5v.01',
  install: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 15zM9 20h6M12 7.5v5.5M9.5 10.5L12 13l2.5-2.5',
  bank: 'M3.5 9.5L12 4l8.5 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20.5h17',
  sync: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
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
  // A piggy bank with a coin going in.
  return html`<svg width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="16" fill="var(--accent)" />
    <g fill="#fff">
      <circle cx="31" cy="13.5" r="5.5" />
      <path d="M19.5 27.5l1.6-9.5 8 6.5z" />
      <ellipse cx="30.5" cy="37" rx="19" ry="14" />
      <rect x="45" y="31.5" width="9.5" height="10.5" rx="3.5" />
      <rect x="17.5" y="44" width="6" height="9.5" rx="2.5" />
      <rect x="35.5" y="44" width="6" height="9.5" rx="2.5" />
    </g>
    <path d="M12.5 36.5c-3.2-.4-4.6-3.2-3-5.2" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" />
    <g fill="var(--accent)">
      <rect x="29.3" y="10.5" width="3.4" height="6" rx="1.2" />
      <rect x="25" y="25.3" width="11" height="3" rx="1.5" />
      <circle cx="41" cy="32" r="1.9" />
      <circle cx="49.3" cy="36" r="1.1" />
      <circle cx="51.8" cy="36" r="1.1" />
    </g>
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
    ${toasts.map((m) => html`<div key=${m.id} class=${'toast' + (m.error ? ' error' : '')}>${m.text}
      ${m.action && html`<button class="toast-action" onClick=${() => { dismiss(m.id); m.action.run(); }}>${m.action.label}</button>`}</div>`)}
  </div>`, toastRoot);
}
function dismiss(id) {
  toasts = toasts.filter((m) => m.id !== id);
  renderToasts();
}

/** A short message. action: { label, run } adds a button, e.g. to undo. */
export function toast(text, { error = false, action = null } = {}) {
  const id = Math.random();
  toasts = [...toasts, { id, text, error, action }];
  renderToasts();
  setTimeout(() => dismiss(id), error || action ? 5000 : 2600);
}
/** An error in the app's language when it has a translation, else as the server said it. */
export function errorText(e) {
  if (e?.message === 'offline') return t('error.offline');
  if (e?.code && has('errors.' + e.code)) return t('errors.' + e.code);
  return e?.message || String(e);
}

export function toastError(e) {
  toast(errorText(e), { error: true });
}

// ------------------------------------------------------------------ modal sheet

const openSheets = [];

/** Bottom sheet on phones, centered dialog on wider screens. */
export function Sheet({ title, onClose, children, footer, wide = false }) {
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = {};
    openSheets.push(me);
    // Escape closes the sheet on top only (one can open over another).
    const onKey = (e) => e.key === 'Escape' && openSheets[openSheets.length - 1] === me && close.current();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current?.querySelector('[autofocus]');
    if (first && matchMedia('(pointer: fine)').matches) first.focus();
    return () => {
      openSheets.splice(openSheets.indexOf(me), 1);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = openSheets.length ? 'hidden' : prev;
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
 * can be typed in one go). With kind 'expense' the amount is shown and typed
 * as a negative number, but saved as the positive amount spent.
 */
export function AmountInput({ value, kind, onSave, placeholder = '–', className = 'amount-input', label, manual = false, autoFocus = false, problem = false }) {
  const amount = (v) => amountText(v, kind);
  const [text, setText] = useState(amount(value));
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState(''); // '', 'saved', 'invalid'
  const dirty = useRef(false); // only typed-in changes are saved
  const ref = useRef(null);
  useEffect(() => {
    if (!focused) setText(amount(value));
  }, [value, focused, kind]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);

  const commit = async () => {
    if (!dirty.current) {
      setText(amount(value));
      return;
    }
    dirty.current = false;
    const parsed = parseTyped(text, kind);
    if (Number.isNaN(parsed)) {
      dirty.current = true;
      setState('invalid');
      toast(t('amount.notSaved', { text }), { error: true });
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

  const decimals = !focused && hasDecimals(value); // from before the budget was set to whole numbers
  return html`<input ref=${ref} class=${[className, state, manual ? 'manual' : '', (problem && value == null) || decimals ? 'invalid' : ''].join(' ')}
    type="text" inputmode=${amountInputMode()} enterkeyhint="next" autocomplete="off"
    title=${decimals ? t('amount.hasDecimals') : null}
    aria-label=${label} placeholder=${placeholder} value=${text}
    onFocus=${(e) => { setFocused(true); setState(''); requestAnimationFrame(() => e.target.select()); }}
    onBlur=${() => { setFocused(false); commit(); }}
    onInput=${(e) => { dirty.current = true; setText(cleanTyped(e)); }}
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

/** True on screens wide enough for two columns. */
export function useWide(query = '(min-width: 900px)') {
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const fn = () => setWide(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return wide;
}

/** On phones, income and expenses are shown one at a time; this picks which. */
export function KindSwitch() {
  const { kindTab } = useStore();
  return html`<div class="kind-switch"><${Segmented} value=${kindTab || 'expense'} onChange=${(v) => setStore({ kindTab: v })} label=${t('common.show')}
    options=${[{ value: 'income', label: t('common.income') }, { value: 'expense', label: t('common.expenses') }]} /></div>`;
}

/** How lists of income and expenses are ordered; remembered on this device. */
export function SortChoice() {
  const { sortBy } = useStore();
  return html`<label class="sort-choice"><span>${t('sort.label')}</span>
    <select class="input" value=${sortBy || 'custom'} onChange=${(e) => setStore({ sortBy: e.target.value })}>
      ${['custom', 'amount', 'name', 'category'].map((v) => html`<option key=${v} value=${v}>${t('sort.' + v)}</option>`)}
    </select></label>`;
}
