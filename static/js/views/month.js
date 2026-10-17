import { html, useState, useRef } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, setStore } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, monthNames, amount } from '../fmt.js';
import { AmountInput, Chips, Dot, Icon, Empty, seriesColor } from '../ui.js';
import { members, itemsOf, monthTotals, categoryById, accountById, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
import { ItemSheet } from './item-sheet.js';
import { CopyYearBanner } from './plan.js';
import { TransactionsSheet } from './bank.js';

function MonthPicker({ month, year, onChange }) {
  const long = monthNames('long');
  const short = monthNames('short');
  const now = new Date();
  const touch = useRef(null);
  const go = (delta) => {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    onChange(m, y);
  };
  // Swipe left/right on the header to change month.
  const onTouchStart = (e) => (touch.current = e.touches[0].clientX);
  const onTouchEnd = (e) => {
    if (touch.current == null) return;
    const dx = e.changedTouches[0].clientX - touch.current;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    touch.current = null;
  };
  return html`<div onTouchStart=${onTouchStart} onTouchEnd=${onTouchEnd}>
    <div class="month-picker">
      <button class="btn ghost icon" onClick=${() => go(-1)} aria-label=${t('month.prev')}><${Icon} name="left" /></button>
      <div class="label">${long[month - 1]} <span class="muted" style="font-weight:500">${year}</span></div>
      <button class="btn ghost icon" onClick=${() => go(1)} aria-label=${t('month.next')}><${Icon} name="right" /></button>
    </div>
    <div class="month-scroller" role="tablist">
      ${short.map((m, i) => html`<button key=${i} role="tab" aria-selected=${i + 1 === month} aria-label=${long[i]}
        class=${(i + 1 === month ? 'active ' : '') + (year === now.getFullYear() && i === now.getMonth() ? 'now' : '')}
        onClick=${() => onChange(i + 1, year)}>${m}</button>`)}
    </div>
  </div>`;
}

function ItemRow({ item, month, year, household, onSaved, onOpen }) {
  const category = categoryById(household, item.category_id);
  const account = accountById(household, item.account_id);
  const meta = [category?.name, account && '→ ' + account.name].filter(Boolean).join(' · ');
  const prev = month > 1 ? item.amounts[month - 2] : item.prev[11];
  const save = async (value) => {
    await api.put(`/api/items/${item.id}/amount`, { year, month, amount: value });
    onSaved(item.id, month, value);
  };
  const actual = item.actual?.[month - 1];
  const planned = item.amounts[month - 1];
  const matches = actual != null && planned != null && Math.abs(actual - planned) < 0.005;
  return html`<div class="list-row">
    <div class="main-col tap" onClick=${() => onOpen(item)} style="cursor:pointer">
      <div class="name">${item.name}</div>
      <div class="meta">
        ${item.fixed && html`<span class="badge" title=${t('item.fixed')}><${Icon} name="repeat" size=${11} stroke=${2.2} />${t('item.fixedShort')}</span>`}
        ${item.note && html`<${Icon} name="note" size=${13} />`}
        ${meta && html`<span class="ellipsis">${meta}</span>`}
      </div>
      ${actual != null && html`<div class="bank-line">
        <span class=${matches ? 'good' : ''}><${Icon} name=${matches ? 'check' : 'bank'} size=${13} stroke=${2.2} /> ${t('month.bankPaid', { amount: amount(actual) })}</span>
        ${!matches && html`<button class="btn small ghost" onClick=${(e) => { e.stopPropagation(); save(actual); }}>${t('month.useBank')}</button>`}
      </div>`}
    </div>
    <${AmountInput} value=${item.amounts[month - 1]} onSave=${save} label=${item.name}
      placeholder=${prev != null ? amount(prev) : '–'} />
  </div>`;
}

function MemberSection({ member, items, month, year, household, onSaved, onOpen, onAdd }) {
  const [showAll, setShowAll] = useState(false);
  const totals = monthTotals(items, month - 1);
  const groups = ['income', 'expense'].map((kind) => {
    const all = items.filter((i) => i.kind === kind);
    const withAmount = all.filter((i) => i.amounts[month - 1] != null);
    return { kind, all, shown: showAll ? all : withAmount, hidden: all.length - withAmount.length };
  });
  const hidden = groups.reduce((n, g) => n + g.hidden, 0);
  return html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head">
      <${Dot} color=${seriesColor(member.color)} size=${12} />
      <h2 class="ellipsis">${member.name}</h2>
      <span class=${'num small ' + (totals.net > 0.5 ? 'good' : totals.net < -0.5 ? 'bad' : 'muted')} style="font-weight:600">${signedMoney(totals.net)}</span>
    </div>
    ${groups.map((g) => (g.shown.length > 0 || (showAll && g.all.length > 0)) && html`<div key=${g.kind}>
      <div class="group-label">${g.kind === 'income' ? t('common.income') : t('common.expenses')}
        <span class="total">${money(g.kind === 'income' ? totals.income : totals.expense)}</span></div>
      <div class="list">${g.shown.map((item) => html`<${ItemRow} key=${item.id} item=${item} month=${month} year=${year}
        household=${household} onSaved=${onSaved} onOpen=${onOpen} />`)}</div>
    </div>`)}
    ${items.length === 0 && html`<p class="small muted" style="padding:4px 16px 8px;margin:0">${t('month.noItems')}</p>`}
    ${hidden > 0 && html`<button class="add-row" style="color:var(--text-2)" onClick=${() => setShowAll(!showAll)}>
      <${Icon} name=${showAll ? 'up' : 'down'} size=${18} />${showAll ? t('month.hideEmpty') : t('month.showEmpty', { n: hidden })}</button>`}
    <button class="add-row" onClick=${() => onAdd(member)}><${Icon} name="plus" size=${18} />${t('month.addItem')}</button>
  </section>`;
}

function Balances({ summary, month, year, household, bank, onSaved }) {
  const long = monthNames('long');
  const accounts = (summary?.accounts || [])
    .map((a) => ({ ...a, account: accountById(household, a.id) }))
    .filter((a) => a.account && !a.account.archived);
  if (!accounts.length) return null;
  return html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head"><${Icon} name="wallet" /><h2>${t('month.balances', { month: long[month - 1] })}</h2></div>
    <p class="small secondary" style="margin:0;padding:0 16px 6px">${t('month.balancesHint')}</p>
    <div class="list">${accounts.map((a) => {
      const manual = a.manual[month - 1];
      const fromBank = a.source?.[month - 1] === 'bank';
      const value = a.balances[month - 1];
      const now = new Date();
      const linked = (bank?.accounts || []).filter((b) => b.account_id === a.id && b.balance != null);
      const bankNow = year === now.getFullYear() && month === now.getMonth() + 1 && linked.length ? linked.reduce((s, b) => s + b.balance, 0) : null;
      const save = async (v) => {
        await api.put(`/api/accounts/${a.id}/balance`, { year, month, amount: v });
        onSaved();
      };
      return html`<div class="list-row" key=${a.id}>
        <${Dot} color=${seriesColor(a.account.color)} />
        <div class="main-col"><div class="name">${a.account.name}</div>
          <div class="meta">${fromBank ? html`<span class="badge accent"><${Icon} name="bank" size=${11} stroke=${2.2} />${t('month.fromBank')}</span>`
            : manual ? html`<span class="badge accent">${t('month.actual')}</span> ${t('month.clearToCompute')}`
            : value != null ? t('month.computed', { amount: money(value) }) : t('month.noBalance')}</div>
          ${bankNow != null && html`<div class="meta">${t('month.bankNow', { amount: money(bankNow) })}</div>`}</div>
        <${AmountInput} value=${manual ? value : null} manual=${manual} placeholder=${value != null ? amount(Math.round(value)) : '–'}
          onSave=${save} label=${a.account.name} />
      </div>`;
    })}</div>
  </section>`;
}

export function Month() {
  const store = useStore();
  const { year, month, household } = store;
  const items = useData(`/api/years/${year}/items`);
  const summary = useData(`/api/summary/${year}`);
  const bank = useData('/api/bank/status');
  const [editing, setEditing] = useState(null); // { item } or { member, kind }
  const [sorting, setSorting] = useState(false);
  const banked = bank.data?.configured && bank.data.accounts.some((a) => a.track);
  const unsorted = bank.data?.unsorted[`${year}-${month}`] || 0;
  const people = members(household);
  const filter = people.some((m) => m.id === store.monthMember) ? store.monthMember : 'all';

  const onSaved = (id, m, value) => {
    items.set((list) => list.map((i) => (i.id === id ? { ...i, amounts: i.amounts.map((v, k) => (k === m - 1 ? value : v)) } : i)));
    summary.reload();
  };

  const list = items.stale ? null : items.data;
  const totals = list ? monthTotals(list, month - 1) : null;

  return html`<div>
    <${MonthPicker} month=${month} year=${year} onChange=${(m, y) => setStore({ month: m, year: y })} />
    <div class="card" style="margin:10px 0 12px">
      <div class="sum-strip">
        <div><div class="label"><${Dot} color=${INCOME_COLOR} size=${8} />${t('common.income')}</div><div class="value">${totals ? money(totals.income) : '–'}</div></div>
        <div><div class="label"><${Dot} color=${EXPENSE_COLOR} size=${8} />${t('common.expenses')}</div><div class="value">${totals ? money(totals.expense) : '–'}</div></div>
        <div><div class="label">${t('common.balance')}</div><div class=${'value ' + (totals?.net > 0.5 ? 'good' : totals?.net < -0.5 ? 'bad' : '')}>${totals ? signedMoney(totals.net) : '–'}</div></div>
      </div>
    </div>
    ${banked && html`<button class="card bank-card" onClick=${() => setSorting(true)}>
      <${Icon} name="bank" />
      <span class="spacer">${unsorted ? html`<strong>${t('month.unsorted', { n: unsorted })}</strong><div class="small secondary">${t('month.unsortedHint')}</div>`
        : html`<span class="secondary">${t('month.bankTransactions')}</span>`}</span>
      <${Icon} name="right" size=${18} />
    </button>`}
    <div style="margin-bottom:12px">
      <${Chips} label=${t('month.filter')} value=${filter} onChange=${(v) => setStore({ monthMember: v === 'all' ? null : v })}
        options=${[{ value: 'all', label: t('month.everyone') }, ...people.map((m) => ({ value: m.id, label: m.name, color: seriesColor(m.color) }))]} />
    </div>
    ${!list ? html`<div class="loading">${t('common.loading')}</div>` : html`
      ${list.length === 0 && html`<${CopyYearBanner} year=${year} />`}
      ${people.filter((m) => filter === 'all' || m.id === filter).map((m) => html`<${MemberSection} key=${m.id + '-' + month}
        member=${m} items=${itemsOf(list, m.id)} month=${month} year=${year} household=${household}
        onSaved=${onSaved} onOpen=${(item) => setEditing({ item })} onAdd=${(member) => setEditing({ member, kind: 'expense' })} />`)}
      ${filter === 'all' && html`<${Balances} summary=${summary.data} month=${month} year=${year} household=${household} bank=${bank.data} onSaved=${summary.reload} />`}
    `}
    ${editing && html`<${ItemSheet} year=${year} item=${editing.item} member=${editing.member} kind=${editing.kind}
      focusMonth=${month} onClose=${() => setEditing(null)} onChanged=${() => { items.reload(); summary.reload(); }} />`}
    ${sorting && html`<${TransactionsSheet} year=${year} month=${month} items=${items.data || []} onClose=${() => setSorting(false)}
      onChanged=${() => { items.reload(); bank.reload(); }} />`}
  </div>`;
}
