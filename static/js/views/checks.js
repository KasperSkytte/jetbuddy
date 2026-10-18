// "Check the numbers": amounts that look 10, 100 or 1000 times off, with
// one-tap fixes. Nothing changes until a button is pressed.
import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, bump } from '../store.js';
import { t } from '../i18n.js';
import { amount, money, monthNames } from '../fmt.js';
import { Sheet, Icon, Dot, toast, toastError } from '../ui.js';
import { memberColor, memberById } from '../model.js';
import { ItemSheet } from './item-sheet.js';

function whereText(where) {
  const short = monthNames('short');
  return where.map((w) => (w.months.length === 12 ? t('checks.wholeYear', { year: w.year }) : `${w.months.map((m) => short[m - 1]).join(', ')} ${w.year}`)).join(' · ');
}

const list = (values) => values.map((v) => amount(v)).join(', ');

function describe(f) {
  const factor = amount(Math.abs(f.factor || 0));
  switch (f.type) {
    case 'item':
      return f.factor
        ? t(f.factor > 0 ? 'checks.itemBigger' : 'checks.itemSmaller', { where: whereText(f.where), factor, values: list(f.values), typical: amount(f.typical) })
        : t('checks.itemOff', { where: whereText(f.where), values: list(f.values), typical: amount(f.typical) });
    case 'split':
      return t('checks.split', { factor, low: whereText(f.low), lowValues: list(f.low_values), high: whereText(f.where), highValues: list(f.high_values) });
    case 'bank':
      return t('checks.bank', { where: whereText(f.where), planned: amount(f.values[0]), actual: amount(f.actual) });
    case 'large':
      return t('checks.large', { where: whereText(f.where), value: amount(f.values[0]), income: money(f.income) });
    case 'balance':
      return t('checks.balance', { where: whereText(f.where), value: money(f.values[0]), expected: money(f.expected) });
  }
  return '';
}

function optionLabel(f, o) {
  if (o.action === 'bank') return t('checks.useBank');
  const n = amount(o.multiply < 1 ? Math.round(1 / o.multiply) : o.multiply);
  const label = t(o.multiply < 1 ? 'checks.divide' : 'checks.multiply', { n });
  // Two possible fixes: say which amounts each one changes.
  return f.options.length > 1 && f.type === 'split' ? `${label}: ${whereText(o.where)}` : label;
}

function Finding({ f, onResult, onOpen }) {
  const { household } = useStore();
  const [busy, setBusy] = useState(false);
  const act = async (url, body) => {
    setBusy(true);
    try {
      onResult(await api.post(url, body));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const fix = (o) => act('/api/checks/fix', {
    item_id: f.item_id ?? null, account_id: f.account_id ?? null, where: o.where,
    multiply: o.action === 'scale' ? o.multiply : null, use_bank: o.action === 'bank',
  });
  return html`<div class="card finding">
    <div class="row">
      ${f.member_id ? html`<${Dot} color=${memberColor(household, f.member_id)} />` : html`<${Icon} name="wallet" size=${18} />`}
      <strong class="spacer">${f.name}</strong>
      ${f.member_id && html`<span class="small muted">${memberById(household, f.member_id)?.name}</span>`}
    </div>
    <p class="small" style="margin:6px 0 10px">${describe(f)}</p>
    <div class="row wrap">
      ${f.options.map((o, i) => html`<button key=${i} class=${'btn small' + (i === 0 ? ' primary' : '')} disabled=${busy} onClick=${() => fix(o)}>${optionLabel(f, o)}</button>`)}
      ${f.item_id && html`<button class="btn small" disabled=${busy} onClick=${() => onOpen(f)}>${t('checks.open')}</button>`}
      <button class="btn small ghost" disabled=${busy} onClick=${() => act('/api/checks/dismiss', { id: f.id })}>${t('checks.dismiss')}</button>
    </div>
  </div>`;
}

export function ChecksSheet({ onClose }) {
  const result = useData('/api/checks');
  const [opening, setOpening] = useState(null); // { item, year }
  const data = result.data;
  const onResult = (r) => {
    result.set(r);
    bump();
  };
  const open = async (f) => {
    try {
      const items = await api.get(`/api/years/${f.year}/items`);
      const item = items.find((i) => i.id === f.item_id);
      if (item) setOpening({ item, year: f.year });
    } catch (e) {
      toastError(e);
    }
  };
  const reset = async () => onResult(await api.post('/api/checks/reset'));
  return html`<${Sheet} wide title=${t('checks.title')} onClose=${onClose}>
    ${!data ? html`<p class="muted">${t('common.loading')}</p>` : html`<div class="stack">
      <p class="small secondary" style="margin:0">${t('checks.intro', { n: amount(data.checked) })}</p>
      ${data.findings.length === 0
        ? html`<div class="notice good-notice"><${Icon} name="check" size=${18} /> ${t('checks.allGood')}</div>`
        : html`<div class="notice bad-notice"><strong>${t('checks.found', { n: data.findings.length })}</strong></div>
          ${data.findings.map((f) => html`<${Finding} key=${f.id} f=${f} onResult=${onResult} onOpen=${open} />`)}`}
      <button class="btn ghost small" style="align-self:flex-start" onClick=${reset}>${t('checks.reset')}</button>
    </div>`}
    ${opening && html`<${ItemSheet} year=${opening.year} item=${opening.item} onClose=${() => setOpening(null)}
      onChanged=${() => { result.reload(); bump(); }} />`}
  </${Sheet}>`;
}
