import { html, useState, useRef } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, setStore } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, monthNames, amount } from '../fmt.js';
import { AmountInput, Chips, Dot, Icon, Empty, Sheet, seriesColor, useWide, KindSwitch, SortChoice, toast, toastError } from '../ui.js';
import { members, itemsOf, monthTotals, categoryById, accountById, sortItems, measureDate, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
import { ItemSheet } from './item-sheet.js';
import { CopyYearBanner } from './plan.js';
import { TransactionsSheet, reconcile } from './bank.js';

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

function ItemRow({ item, month, year, household, onSaved, onOpen, proposals = [], onPropose, onRefuse, onBank }) {
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
          <${Icon} name=${matches ? 'check' : 'bank'} size=${13} stroke=${2.2} /> ${t('month.bankPaid', { amount: amount(actual) })}</button>
        ${!matches && html`<button class="btn small ghost" title=${t('month.useBankHint')} onClick=${(e) => { e.stopPropagation(); save(actual); }}>${t('month.useBank')}</button>`}
      </div>`}
    </div>
    <${AmountInput} value=${item.amounts[month - 1]} onSave=${save} label=${item.name} problem=${!!item.unreadable?.[month - 1]}
      placeholder=${prev != null ? amount(prev) : '–'} />
      ${actual == null && proposals.length === 1 && html`<div class="proposal" onClick=${(e) => e.stopPropagation()}>
        <${Icon} name="bank" size=${13} stroke=${2.2} />
        <span class="spacer">${t('month.proposal', { name: txName(proposals[0]), date: dayMonth(proposals[0].booking_date) })}${proposals[0].via && html` <span class="via">${proposals[0].via}</span>`}</span>
        <button class="btn small" onClick=${() => onPropose(proposals[0], item)}>${t('month.proposalUse')}</button>
        <button class="btn small ghost icon" aria-label=${t('month.proposalNo')} title=${t('month.proposalNo')} onClick=${() => onRefuse(proposals[0], item)}><${Icon} name="close" size=${15} /></button>
      </div>`}
      ${actual == null && proposals.length > 1 && html`<div class="proposal" onClick=${(e) => e.stopPropagation()}>
        <${Icon} name="bank" size=${13} stroke=${2.2} />
        <span class="spacer">${t('month.proposals', { n: proposals.length })}</span>
        <button class="btn small" onClick=${() => onBank(item)}>${t('month.proposalPick')}</button>
      </div>`}
  </div>`;
}

/** One person's income or expenses for the month. */
function MemberSection({ member, kind, items, month, year, household, onSaved, onOpen, onAdd, sortBy, proposalsOf, onPropose, onRefuse, onBank }) {
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
      <span class="num small muted" style="font-weight:600">${money(kind === 'income' ? totals.income : totals.expense)}</span>
    </div>
    <div class="list">${shown.map((item) => html`<${ItemRow} key=${item.id} item=${item} month=${month} year=${year}
      household=${household} onSaved=${onSaved} onOpen=${onOpen} proposals=${proposalsOf(item)} onPropose=${onPropose} onRefuse=${onRefuse} onBank=${onBank} />`)}</div>
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
  const [sorting, setSorting] = useState(false);
  const banked = bank.data?.configured && bank.data.accounts.some((a) => a.budget); // the budget account is from a bank
  const unsorted = bank.data?.unsorted[`${year}-${month}`] || 0;
  const differ = items.data && !items.stale ? reconcile(items.data, month).differ.length : 0;
  // Bank transactions not on the budget yet, offered at the item with exactly that amount.
  const txs = useData(banked ? `/api/bank/transactions?year=${year}&month=${month}` : null);
  const open = (txs.data || []).filter((x) => !x.item_id && !x.ignored);
  const proposalsOf = (item) => {
    const planned = item.amounts[month - 1];
    if (!planned) return [];
    return open.filter((x) => (item.kind === 'income' ? x.amount > 0 : x.amount < 0) && Math.abs(Math.abs(x.amount) - planned) < 0.005
      && !x.not_items.includes(item.id));
  };
  const [bankItem, setBankItem] = useState(null); // the item whose bank transactions are open
  const bankChanged = () => {
    items.reload();
    txs.reload();
    bank.reload();
  };
  const act = async (fn, message) => {
    try {
      await fn();
      if (message) toast(message);
      bankChanged();
    } catch (e) {
      toastError(e);
    }
  };
  // Put on the item, and from now on automatically (same text and amount).
  const propose = (tx, item) => act(() => api.put(`/api/bank/transactions/${tx.id}`, { item_id: item.id, rule: tx.pattern || null, rule_amount: true }), t('month.proposalDone'));
  const refuse = (tx, item) => act(() => api.post(`/api/bank/transactions/${tx.id}/not/${item.id}`));
  const takeOff = (tx) => act(() => api.put(`/api/bank/transactions/${tx.id}`, { item_id: null }), t('month.takenOff'));
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
      onSaved=${onSaved} onOpen=${(item) => setEditing({ item })} onAdd=${onAdd} sortBy=${store.sortBy}
      proposalsOf=${proposalsOf} onPropose=${propose} onRefuse=${refuse} onBank=${setBankItem} />`);
  };

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
      <span class="spacer"><strong>${t('month.reconcile', { month: monthNames('long')[month - 1] })}</strong>
        <div class="small secondary">${unsorted || differ ? [unsorted && t('month.notInBudget', { n: unsorted }), differ && t('month.deviations', { n: differ })].filter(Boolean).join(' · ')
          : t('month.allReconciled')}</div></span>
      <${Icon} name="right" size=${18} />
    </button>`}
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
            <span class="num secondary" style="font-weight:650">${totals ? money(kind === 'income' ? totals.income : totals.expense) : ''}</span></div>
          ${column(kind)}</div>`)}</div>`
        : column(store.kindTab || 'expense')}
      ${filter === 'all' && html`<${Balances} summary=${summary.data} month=${month} year=${year} household=${household} bank=${bank.data} onSaved=${summary.reload} />`}
    `}
    ${editing && html`<${ItemSheet} year=${year} item=${editing.item} member=${editing.member} kind=${editing.kind}
      focusMonth=${month} onClose=${() => setEditing(null)} onChanged=${() => { items.reload(); summary.reload(); }} />`}
    ${bankItem && html`<${ItemBankSheet} item=${(items.data || []).find((i) => i.id === bankItem.id) || bankItem} month=${month}
      on=${(txs.data || []).filter((x) => x.item_id === bankItem.id)} proposals=${proposalsOf(bankItem)}
      onPropose=${propose} onRefuse=${refuse} onTakeOff=${takeOff} onClose=${() => setBankItem(null)} />`}
    ${sorting && html`<${TransactionsSheet} year=${year} month=${month} items=${items.data || []} onClose=${() => setSorting(false)}
      onChanged=${() => { items.reload(); bank.reload(); txs.reload(); }} />`}
  </div>`;
}

function dayMonth(iso) {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { day: 'numeric', month: 'short' }).format(new Date(iso + 'T12:00:00'));
}

function txName(tx) {
  return tx.counterparty || tx.text || '–';
}

/**
 * An item's bank transactions this month: the ones on it (which can be taken
 * off again) and the ones with exactly its amount (to put on, or turn down).
 */
function ItemBankSheet({ item, month, on, proposals, onPropose, onRefuse, onTakeOff, onClose }) {
  const row = (tx, buttons) => html`<div class="list-row" key=${tx.id} style="min-height:56px">
    <div class="main-col"><div class="name ellipsis" style="font-weight:520">${txName(tx)}</div>
      <div class="meta">${tx.via && html`<span class="via">${tx.via}</span>`} ${dayMonth(tx.booking_date)}${tx.counterparty && tx.text ? ' · ' + tx.text : ''}</div></div>
    <span class="num" style="font-weight:650">${amount(Math.abs(tx.amount))}</span>
    ${buttons}
  </div>`;
  return html`<${Sheet} title=${item.name} onClose=${onClose}>
    <div class="stack">
      <div>
        <div class="group-label" style="padding-left:0">${t('month.bankOn', { month: monthNames('long')[month - 1] })}</div>
        ${on.length === 0 ? html`<p class="small muted" style="margin:0">${t('month.bankNone')}</p>`
          : html`<div class="list" style="margin:0 -18px">${on.map((tx) => row(tx, html`<button class="btn small ghost" onClick=${() => onTakeOff(tx)}>${t('month.takeOff')}</button>`))}</div>
            <p class="small muted" style="margin:6px 0 0">${t('month.takeOffHint')}</p>`}
      </div>
      ${proposals.length > 0 && html`<div>
        <div class="group-label" style="padding-left:0">${t('month.sameAmount')}</div>
        <div class="list" style="margin:0 -18px">${proposals.map((tx) => row(tx, html`<div class="row" style="gap:6px">
          <button class="btn small" onClick=${() => onPropose(tx, item)}>${t('month.proposalUse')}</button>
          <button class="btn small ghost icon" aria-label=${t('month.proposalNo')} title=${t('month.proposalNo')} onClick=${() => onRefuse(tx, item)}><${Icon} name="close" size=${15} /></button></div>`))}</div>
      </div>`}
    </div>
  </${Sheet}>`;
}
