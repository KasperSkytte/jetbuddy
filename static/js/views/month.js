import { html, useState, useRef } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, setStore } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, monthNames, amount, amountText, signed } from '../fmt.js';
import { AmountInput, Chips, Dot, Icon, Segmented, seriesColor, useWide, KindSwitch, SortChoice } from '../ui.js';
import { members, itemsOf, monthTotals, categoryById, accountById, sortItems, measureDate, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
import { ItemSheet } from './item-sheet.js';
import { CopyYearBanner } from './plan.js';
import { Reconcile, ItemBankSheet, itemStatus, differs } from './reconcile.js';

function MonthPicker({ month, year, onChange, reconciled = [] }) {
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
      ${short.map((m, i) => html`<button key=${i} role="tab" aria-selected=${i + 1 === month}
        aria-label=${reconciled.includes(`${year}-${i + 1}`) ? `${long[i]}, ${t('month.reconciledMark')}` : long[i]}
        title=${reconciled.includes(`${year}-${i + 1}`) ? t('month.reconciledMark') : null}
        class=${(i + 1 === month ? 'active ' : '') + (year === now.getFullYear() && i === now.getMonth() ? 'now ' : '')
          + (reconciled.includes(`${year}-${i + 1}`) ? 'done' : '')}
        onClick=${() => onChange(i + 1, year)}>${m}</button>`)}
    </div>
  </div>`;
}

function ItemRow({ item, month, year, household, onSaved, onOpen, onBank }) {
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
  return html`<div class="list-row item-line">
    <div class="main-col tap" onClick=${() => onOpen(item)} style="cursor:pointer">
      <div class="name">${item.name}</div>
      <div class="meta">
        ${item.fixed && html`<span class="badge" title=${t('item.fixed')}><${Icon} name="repeat" size=${11} stroke=${2.2} />${t('item.fixedShort')}</span>`}
        ${item.note && html`<${Icon} name="note" size=${13} />`}
        ${meta && html`<span class="ellipsis">${meta}</span>`}
      </div>
      ${item.unreadable?.[month - 1] && planned == null && html`<div class="small bad" style="margin-top:2px">
        ${t('month.unreadable', { raw: item.unreadable[month - 1] })}</div>`}
      ${actual != null && html`<div class="bank-line">
        <button class=${'linkish ' + (matches ? 'good' : '')} title=${t('month.bankShow')} onClick=${(e) => { e.stopPropagation(); onBank(item); }}>
          <${Icon} name=${matches ? 'check' : 'bank'} size=${13} stroke=${2.2} /> ${t('month.bankPaid', { amount: amount(signed(actual, item.kind)) })}</button>
      </div>`}
    </div>
    <${AmountInput} value=${item.amounts[month - 1]} kind=${item.kind} onSave=${save} label=${item.name} problem=${!!item.unreadable?.[month - 1]}
      placeholder=${prev != null ? amountText(prev, item.kind) : '–'} />
  </div>`;
}

/** One person's income or expenses for the month. */
function MemberSection({ member, kind, items, month, year, household, onSaved, onOpen, onAdd, sortBy, onBank }) {
  const [showAll, setShowAll] = useState(false);
  const all = sortItems(items.filter((i) => i.kind === kind), sortBy, { month, household });
  const withAmount = all.filter((i) => i.amounts[month - 1] != null || i.unreadable?.[month - 1]);
  const shown = showAll ? all : withAmount;
  const hidden = all.length - withAmount.length;
  const totals = monthTotals(all, month - 1);
  return html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head">
      <${Dot} color=${seriesColor(member.color)} size=${12} />
      <h2 class="ellipsis">${member.name}</h2>
      <span class="num small muted" style="font-weight:600">${money(kind === 'income' ? totals.income : -totals.expense)}</span>
    </div>
    <div class="list">${shown.map((item) => html`<${ItemRow} key=${item.id} item=${item} month=${month} year=${year}
      household=${household} onSaved=${onSaved} onOpen=${onOpen} onBank=${onBank} />`)}</div>
    ${all.length === 0 && html`<p class="small muted" style="padding:4px 16px 8px;margin:0">${t('month.noItems')}</p>`}
    ${hidden > 0 && html`<button class="add-row" style="color:var(--text-2)" onClick=${() => setShowAll(!showAll)}>
      <${Icon} name=${showAll ? 'up' : 'down'} size=${18} />${showAll ? t('month.hideEmpty') : t('month.showEmpty', { n: hidden })}</button>`}
    <button class="add-row" onClick=${() => onAdd(member, kind)}><${Icon} name="plus" size=${18} />${kind === 'income' ? t('plan.addIncome') : t('plan.addExpense')}</button>
  </section>`;
}

function Balances({ summary, month, year, household, bank, onSaved }) {
  const long = monthNames('long');
  const accounts = (summary?.accounts || [])
    .map((a) => ({ ...a, account: accountById(household, a.id) }))
    .filter((a) => a.account && !a.account.archived);
  if (!accounts.length) return null;
  return html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head"><${Icon} name="wallet" /><h2>${t(household.settings.balance_day === 'before_payday' ? 'month.balancesBefore' : 'month.balances', { month: long[month - 1] })}</h2></div>
    <p class="small secondary" style="margin:0;padding:0 16px 6px">${t('month.measuredOn', { date: measureDate(year, month, household.settings.balance_day) })} ${t('month.balancesHint')}</p>
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
  const banked = bank.data?.configured && bank.data.accounts.some((a) => a.budget); // the budget account is from a bank
  const unsorted = bank.data?.unsorted[`${year}-${month}`] || 0;
  const differ = items.data && !items.stale ? itemStatus(items.data, month).filter(differs).length : 0;
  const txs = useData(banked ? `/api/bank/transactions?year=${year}&month=${month}` : null);
  const reconciling = banked && store.monthMode === 'reconcile';
  const [bankItem, setBankItem] = useState(null); // the item whose bank transactions are open
  const bankChanged = () => {
    items.reload();
    txs.reload();
    bank.reload();
    summary.reload();
  };
  const people = members(household);
  const filter = people.some((m) => m.id === store.monthMember) ? store.monthMember : 'all';

  const onSaved = (id, m, value) => {
    items.set((list) => list.map((i) => (i.id === id ? { ...i, amounts: i.amounts.map((v, k) => (k === m - 1 ? value : v)) } : i)));
    summary.reload();
  };

  const list = items.stale ? null : items.data;
  const totals = list ? monthTotals(list, month - 1) : null;
  const wide = useWide();
  const onAdd = (member, kind) => setEditing({ member, kind });

  // A column of income or expenses, by person. People with nothing on that
  // side (the kids' income, say) are left out unless picked in the filter.
  const column = (kind) => {
    const shown = people.filter((m) => (filter === 'all' ? itemsOf(list, m.id).some((i) => i.kind === kind) : m.id === filter));
    if (!shown.length) {
      return html`<section class="card flush" style="margin-bottom:12px">
        <p class="small muted" style="padding:14px 16px 4px;margin:0">${kind === 'income' ? t('month.noIncome') : t('month.noExpenses')}</p>
        <button class="add-row" onClick=${() => onAdd(people[0], kind)}><${Icon} name="plus" size=${18} />${kind === 'income' ? t('plan.addIncome') : t('plan.addExpense')}</button>
      </section>`;
    }
    return shown.map((m) => html`<${MemberSection} key=${m.id + '-' + kind + '-' + month} member=${m} kind=${kind}
      items=${itemsOf(list, m.id)} month=${month} year=${year} household=${household}
      onSaved=${onSaved} onOpen=${(item) => setEditing({ item })} onAdd=${onAdd} sortBy=${store.sortBy} onBank=${setBankItem} />`);
  };

  return html`<div>
    <${MonthPicker} month=${month} year=${year} onChange=${(m, y) => setStore({ month: m, year: y })} reconciled=${bank.data?.reconciled} />
    <div class="card" style=${{ margin: '10px 0 12px', display: reconciling ? 'none' : null }}>
      <div class="sum-strip">
        <div><div class="label"><${Dot} color=${INCOME_COLOR} size=${8} />${t('common.income')}</div><div class="value">${totals ? money(totals.income) : '–'}</div></div>
        <div><div class="label"><${Dot} color=${EXPENSE_COLOR} size=${8} />${t('common.expenses')}</div><div class="value">${totals ? money(-totals.expense) : '–'}</div></div>
        <div><div class="label">${t('common.balance')}</div><div class=${'value ' + (totals?.net > 0.5 ? 'good' : totals?.net < -0.5 ? 'bad' : '')}>${totals ? signedMoney(totals.net) : '–'}</div></div>
      </div>
    </div>
    ${banked && html`<div class="mode-switch"><${Segmented} value=${reconciling ? 'reconcile' : 'budget'} label=${t('month.mode')}
      onChange=${(v) => setStore({ monthMode: v })}
      options=${[{ value: 'budget', label: t('month.modeBudget') },
        { value: 'reconcile', label: unsorted ? t('month.modeReconcileN', { n: unsorted }) : t('month.modeReconcile') }]} />
      ${!reconciling && html`<span class="small secondary">${unsorted || differ ? [unsorted && t('month.notInBudget', { n: unsorted }), differ && t('month.deviations', { n: differ })].filter(Boolean).join(' · ')
        : t('month.allReconciled')}</span>`}</div>`}
    ${reconciling ? (!list || !txs.data ? html`<div class="loading">${t('common.loading')}</div>`
      : html`<${Reconcile} year=${year} month=${month} items=${list} txs=${txs.data} onChanged=${bankChanged} />`) : html`
    <div style="margin-bottom:12px">
      <${Chips} label=${t('month.filter')} value=${filter} onChange=${(v) => setStore({ monthMember: v === 'all' ? null : v })}
        options=${[{ value: 'all', label: t('month.everyone') }, ...people.map((m) => ({ value: m.id, label: m.name, color: seriesColor(m.color) }))]} />
    </div>
    ${!list ? html`<div class="loading">${t('common.loading')}</div>` : html`
      ${list.length === 0 && html`<${CopyYearBanner} year=${year} />`}
      ${!wide && html`<${KindSwitch} />`}
      <div class="list-tools"><${SortChoice} /></div>
      ${wide ? html`<div class="plan-cols">${['income', 'expense'].map((kind) => html`<div key=${kind}>
          <div class="col-head"><h2><${Dot} color=${kind === 'income' ? INCOME_COLOR : EXPENSE_COLOR} size=${10} />
            ${kind === 'income' ? t('common.income') : t('common.expenses')}</h2>
            <span class="num secondary" style="font-weight:650">${totals ? money(kind === 'income' ? totals.income : -totals.expense) : ''}</span></div>
          ${column(kind)}</div>`)}</div>`
        : column(store.kindTab || 'expense')}
      ${filter === 'all' && html`<${Balances} summary=${summary.data} month=${month} year=${year} household=${household} bank=${bank.data} onSaved=${summary.reload} />`}
    `}`}
    ${editing && html`<${ItemSheet} year=${year} item=${editing.item} member=${editing.member} kind=${editing.kind}
      focusMonth=${month} onClose=${() => setEditing(null)} onChanged=${() => { items.reload(); summary.reload(); }} />`}
    ${bankItem && txs.data && html`<${ItemBankSheet} item=${(items.data || []).find((i) => i.id === bankItem.id) || bankItem} year=${year} month=${month}
      txs=${txs.data} items=${items.data || []} onClose=${() => setBankItem(null)} onChanged=${bankChanged} />`}
  </div>`;
}
