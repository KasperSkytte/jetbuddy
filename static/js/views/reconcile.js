// Reconciling a month: every transaction on the budget account is put on a
// budget item (or ignored, or moved to the month it belongs to), and each
// item's budget is held up against what the bank actually paid. The point is
// to see where the budget isn't followed, not to quietly change it.
import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { t } from '../i18n.js';
import { money, amount, signed, signedMoney, monthNames } from '../fmt.js';
import { Sheet, Icon, Dot, Chips, toast, toastError, useWide } from '../ui.js';
import { members, memberById, memberColor, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
import { AssignView } from './bank.js';

export function txName(tx) {
  return tx.counterparty || tx.text || '–';
}

function dayMonth(iso) {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { day: 'numeric', month: 'short' }).format(new Date(iso + 'T12:00:00'));
}

const shift = (year, month, by) => {
  const d = new Date(year, month - 1 + by, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
};

/**
 * Each item that has a budget or a bank amount this month, with its status:
 * ok, more or less than budgeted, missing (budgeted, nothing from the bank)
 * or unplanned (paid, not budgeted). Largest difference first.
 */
export function itemStatus(items, month) {
  const rows = [];
  for (const item of items) {
    const planned = item.amounts[month - 1] || 0;
    const actual = item.actual?.[month - 1] ?? null;
    if (!planned && actual == null) continue;
    const diff = (actual ?? 0) - planned;
    const status = actual == null ? 'missing' : !planned ? 'unplanned' : Math.abs(diff) < 1 ? 'ok' : diff > 0 ? 'more' : 'less';
    // Paying more for an expense, or getting less income, is the bad way round.
    const bad = status === 'missing' ? item.kind === 'income' : status === 'ok' ? false : item.kind === 'expense' ? diff > 0 : diff < 0;
    rows.push({ item, planned, actual, diff, status, bad });
  }
  return rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

/** Runs an action, reloads, and says so, with an undo when one is given. */
function useAct(onChanged) {
  return async (fn, message, undo) => {
    try {
      const result = await fn();
      onChanged();
      if (message) {
        toast(message, undo && {
          action: {
            label: t('common.undo'),
            run: async () => {
              try {
                await undo(result);
                onChanged();
              } catch (e) {
                toastError(e);
              }
            },
          },
        });
      }
    } catch (e) {
      toastError(e);
    }
  };
}

/** Put a transaction on an item (this one only, no rule), with an undo. */
function putOn(act, tx, item, rule = false) {
  return act(
    () => api.put(`/api/bank/transactions/${tx.id}`, { item_id: item.id, rule: rule ? tx.pattern || null : null, rule_amount: true }),
    t('reconcile.putOn', { name: item.name }),
    async (r) => {
      if (r?.rule_id) await api.del(`/api/bank/rules/${r.rule_id}`);
      await api.put(`/api/bank/transactions/${tx.id}`, { item_id: null, remember: false });
    },
  );
}

function TxLine({ tx, children, sub }) {
  return html`<div class="rc-tx">
    <div class="row" style="gap:10px;align-items:flex-start">
      <div class="spacer" style="min-width:0">
        <div class="ellipsis" style="font-weight:560">${txName(tx)}</div>
        <div class="small muted">${tx.via && html`<span class="via">${tx.via}</span> `}${dayMonth(tx.booking_date)}${tx.counterparty && tx.text ? ' · ' + tx.text : ''}
          ${tx.manual_month && html` · <span class="badge">${t('reconcile.moved')}</span>`}</div>
        ${sub}
      </div>
      <span class=${'num ' + (tx.amount > 0 ? 'good' : '')} style="font-weight:650">${tx.amount > 0 ? '+' : ''}${amount(tx.amount)}</span>
    </div>
    ${children && html`<div class="rc-actions">${children}</div>`}
  </div>`;
}

/** A transaction not on the budget yet: the best guess in one tap, or choose, ignore or move. */
function InboxTx({ tx, items, year, month, act, onChoose }) {
  const { household } = useStore();
  const [more, setMore] = useState(false);
  const long = monthNames('long');
  const guess = tx.suggestions.map((id) => items.find((i) => i.id === id)).find(Boolean);
  const prev = shift(year, month, -1);
  const next = shift(year, month, 1);
  const move = (to) => act(() => api.put(`/api/bank/transactions/${tx.id}/month`, to), t('reconcile.movedTo', { month: long[to.month - 1] }),
    () => api.put(`/api/bank/transactions/${tx.id}/month`, tx.manual_month ? { year, month } : {}));
  const ignore = () => act(() => api.put(`/api/bank/transactions/${tx.id}`, { ignored: true }), t('reconcile.ignored'),
    () => api.put(`/api/bank/transactions/${tx.id}`, { item_id: null, ignored: false, remember: false }));
  return html`<${TxLine} tx=${tx}>
    ${guess && html`<button class="btn small primary" onClick=${() => putOn(act, tx, guess)}>→ ${guess.name}
      ${items.some((i) => i !== guess && i.name === guess.name) && html`<span style="font-weight:500"> · ${memberById(household, guess.member_id)?.name}</span>`}</button>`}
    <button class=${'btn small' + (guess ? '' : ' primary')} onClick=${() => onChoose(tx)}>${t('reconcile.choose')}</button>
    <button class="btn small ghost icon" aria-label=${t('reconcile.more')} aria-expanded=${more} onClick=${() => setMore(!more)}><${Icon} name="dots" size=${17} /></button>
    ${more && html`<div class="rc-more">
      <button class="btn small" onClick=${ignore}>${t('reconcile.ignore')}</button>
      <button class="btn small" onClick=${() => move(prev)}>← ${t('reconcile.moveTo', { month: long[prev.month - 1] })}</button>
      <button class="btn small" onClick=${() => move(next)}>${t('reconcile.moveTo', { month: long[next.month - 1] })} →</button>
      <p class="small muted" style="margin:2px 0 0;flex-basis:100%">${t('reconcile.ignoreHint')}</p>
    </div>`}
  </${TxLine}>`;
}

/** A transaction that is dealt with: where it went, and undo. */
function DoneTx({ tx, items, year, month, act }) {
  const item = tx.item_id && items.find((i) => i.id === tx.item_id);
  const undo = () => (tx.ignored
    ? act(() => api.put(`/api/bank/transactions/${tx.id}`, { item_id: null, ignored: false, remember: false }), t('reconcile.backToInbox'))
    : act(() => api.put(`/api/bank/transactions/${tx.id}`, { item_id: null }), t('reconcile.takenOff', { name: item?.name || '' }),
      () => api.put(`/api/bank/transactions/${tx.id}`, { item_id: tx.item_id })));
  return html`<${TxLine} tx=${tx} sub=${html`<div class="small" style="margin-top:2px">${item ? html`→ <strong>${item.name}</strong>` : t('reconcile.ignoredLabel')}</div>`}>
    <button class="btn small ghost" onClick=${undo}>${item ? t('reconcile.takeOff') : t('reconcile.unignore')}</button>
    ${tx.manual_month && html`<button class="btn small ghost" onClick=${() => act(() => api.put(`/api/bank/transactions/${tx.id}/month`, {}), t('reconcile.movedBack'))}>${t('reconcile.moveBack')}</button>`}
  </${TxLine}>`;
}

const STATUS_LABEL = {
  ok: () => '✓',
  more: (r) => t('reconcile.more_', { diff: amount(Math.abs(r.diff)) }),
  less: (r) => t('reconcile.less_', { diff: amount(Math.abs(r.diff)) }),
  missing: (r) => t(r.item.kind === 'income' ? 'reconcile.notReceived' : 'reconcile.notPaid'),
  unplanned: () => t('reconcile.unplanned'),
};

function ItemLine({ row, onOpen }) {
  const { household } = useStore();
  const { item, planned, actual, status, bad } = row;
  return html`<button class="rc-item" onClick=${() => onOpen(item)}>
    <${Dot} color=${memberColor(household, item.member_id)} />
    <span class="spacer" style="min-width:0;text-align:left">
      <span class="ellipsis" style="display:block;font-weight:560">${item.name}<span class="small muted" style="font-weight:400"> · ${memberById(household, item.member_id)?.name}</span></span>
      <span class="small secondary">${t(item.kind === 'income' ? 'reconcile.budgetVsReceived' : 'reconcile.budgetVsPaid', { planned: amount(signed(planned, item.kind)), actual: actual == null ? '–' : amount(signed(actual, item.kind)) })}</span>
    </span>
    <span class=${'rc-status ' + status + (bad ? ' bad' : status === 'ok' ? ' good' : '')}>${STATUS_LABEL[status](row)}</span>
  </button>`;
}

/**
 * An item's bank transactions this month: the ones on it (take off), those
 * with exactly its amount (put on, or not this one), and setting the budget
 * to what was paid, which is a change of plan and says so.
 */
export function ItemBankSheet({ item, year, month, txs, items, onClose, onChanged }) {
  const { household } = useStore();
  const act = useAct(onChanged);
  const moveTo = (memberId) => act(() => api.patch(`/api/items/${item.id}?year=${year}`, { member_id: memberId }),
    t('reconcile.movedItem', { name: item.name, member: memberById(household, memberId)?.name }),
    () => api.patch(`/api/items/${item.id}?year=${year}`, { member_id: item.member_id }));
  const long = monthNames('long');
  const on = txs.filter((x) => x.item_id === item.id);
  const planned = item.amounts[month - 1];
  const sameAmount = planned
    ? txs.filter((x) => !x.item_id && !x.ignored && (item.kind === 'income' ? x.amount > 0 : x.amount < 0)
      && Math.abs(Math.abs(x.amount) - planned) < 0.005 && !x.not_items.includes(item.id))
    : [];
  const actual = item.actual?.[month - 1];
  const setBudget = () => act(() => api.put(`/api/items/${item.id}/amount`, { year, month, amount: actual }),
    t('reconcile.budgetSet', { amount: amount(signed(actual, item.kind)) }),
    () => api.put(`/api/items/${item.id}/amount`, { year, month, amount: planned ?? null }));
  return html`<${Sheet} title=${item.name} onClose=${onClose}>
    <div class="stack">
      <label class="field"><span>${t('item.whose')}</span>
        <select class="input" value=${item.member_id} onChange=${(e) => moveTo(Number(e.target.value))}>
          ${members(household).map((m) => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}</select></label>
      <div class="sum-strip" style="grid-template-columns:repeat(3,1fr)">
        <div><div class="label">${t('reconcile.budget')}</div><div class="value">${planned != null ? amount(signed(planned, item.kind)) : '–'}</div></div>
        <div><div class="label">${t(item.kind === 'income' ? 'reconcile.received' : 'reconcile.paid')}</div><div class="value">${actual != null ? amount(signed(actual, item.kind)) : '–'}</div></div>
        <div><div class="label">${t('reconcile.difference')}</div><div class="value">${actual != null ? signedMoney(signed(actual - (planned || 0), item.kind)) : '–'}</div></div>
      </div>
      <div>
        <div class="group-label" style="padding-left:0">${t('reconcile.onItem', { month: long[month - 1] })}</div>
        ${on.length === 0 ? html`<p class="small muted" style="margin:0">${t('reconcile.noneYet')}</p>`
          : on.map((tx) => html`<${TxLine} key=${tx.id} tx=${tx}>
            <button class="btn small ghost" onClick=${() => act(() => api.put(`/api/bank/transactions/${tx.id}`, { item_id: null }),
              t('reconcile.takenOff', { name: item.name }), () => api.put(`/api/bank/transactions/${tx.id}`, { item_id: item.id }))}>${t('reconcile.takeOff')}</button>
          </${TxLine}>`)}
      </div>
      ${sameAmount.length > 0 && html`<div>
        <div class="group-label" style="padding-left:0">${t('reconcile.sameAmount')}</div>
        ${sameAmount.map((tx) => html`<${TxLine} key=${tx.id} tx=${tx}>
          <button class="btn small primary" onClick=${() => putOn(act, tx, item)}>${t('reconcile.putOnShort')}</button>
          <button class="btn small ghost" onClick=${() => act(() => api.post(`/api/bank/transactions/${tx.id}/not/${item.id}`), t('reconcile.notThis'),
            () => api.del(`/api/bank/transactions/${tx.id}/not/${item.id}`))}>${t('reconcile.notThis')}</button>
        </${TxLine}>`)}
      </div>`}
      ${actual != null && Math.abs(actual - (planned || 0)) >= 1 && html`<div class="notice" style="margin:0;background:var(--surface-2)">
        <p class="small" style="margin:0 0 8px">${t('reconcile.setBudgetHint')}</p>
        <button class="btn small" onClick=${setBudget}>${t('reconcile.setBudget', { month: long[month - 1], amount: amount(signed(actual, item.kind)) })}</button>
      </div>`}
    </div>
  </${Sheet}>`;
}

/** The Afstem mode of the Month page. */
export function Reconcile({ year, month, items, txs, onChanged }) {
  const wide = useWide();
  const act = useAct(onChanged);
  const [choosing, setChoosing] = useState(null);
  const [itemOpen, setItemOpen] = useState(null);
  const [chosen, setFilter] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const long = monthNames('long');
  const inbox = txs.filter((x) => !x.item_id && !x.ignored);
  const done = txs.filter((x) => x.item_id || x.ignored);
  const rows = itemStatus(items, month);
  const groups = {
    differ: rows.filter((r) => ['more', 'less', 'unplanned'].includes(r.status)),
    missing: rows.filter((r) => r.status === 'missing'),
    ok: rows.filter((r) => r.status === 'ok'),
    all: rows,
  };
  const filter = chosen || (groups.differ.length ? 'differ' : 'all');
  const totals = (kind) => rows.filter((r) => r.item.kind === kind).reduce((s, r) => ({ planned: s.planned + r.planned, actual: s.actual + (r.actual || 0) }), { planned: 0, actual: 0 });
  const income = totals('income');
  const expense = totals('expense');

  const inboxCard = html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head"><${Icon} name="bank" /><h2 class="spacer">${t('reconcile.inbox')}</h2><span class="num small muted" style="font-weight:600">${inbox.length}</span></div>
    ${inbox.length === 0
      ? html`<p class="small" style="margin:0;padding:0 16px 14px"><span class="good">✓</span> ${t('reconcile.inboxEmpty')}</p>`
      : html`<p class="small secondary" style="margin:0;padding:0 16px 6px">${t('reconcile.inboxHint')}</p>
        ${inbox.map((tx) => html`<${InboxTx} key=${tx.id} tx=${tx} items=${items} year=${year} month=${month} act=${act} onChoose=${setChoosing} />`)}`}
    ${done.length > 0 && html`<button class="add-row" style="color:var(--text-2)" onClick=${() => setShowDone(!showDone)}>
      <${Icon} name=${showDone ? 'up' : 'down'} size=${18} />${t('reconcile.doneCount', { n: done.length })}</button>`}
    ${showDone && done.map((tx) => html`<${DoneTx} key=${tx.id} tx=${tx} items=${items} year=${year} month=${month} act=${act} />`)}
  </section>`;

  const itemsCard = html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head"><${Icon} name="plan" /><h2 class="spacer">${t('reconcile.items')}</h2></div>
    <p class="small secondary" style="margin:0;padding:0 16px 8px">${t('reconcile.itemsHint')}</p>
    <div style="padding:0 16px 8px"><${Chips} label=${t('reconcile.items')} value=${filter} onChange=${setFilter}
      options=${['differ', 'missing', 'ok', 'all'].map((k) => ({ value: k, label: `${t('reconcile.f_' + k)} (${groups[k].length})` }))} /></div>
    ${groups[filter].length === 0
      ? html`<p class="small muted" style="margin:0;padding:4px 16px 14px">${t('reconcile.noneHere')}</p>`
      : html`<div class="list">${groups[filter].map((r) => html`<${ItemLine} key=${r.item.id} row=${r} onOpen=${setItemOpen} />`)}</div>`}
    ${filter === 'missing' && groups.missing.length > 0 && html`<p class="small muted" style="margin:0;padding:8px 16px 12px">${t('reconcile.missingHint')}</p>`}
  </section>`;

  return html`<div>
    <div class="card" style="margin-bottom:12px">
      <div class="row wrap" style="row-gap:10px">
        <strong class="spacer">${inbox.length ? t('reconcile.left', { n: inbox.length }) : html`<span class="good">✓ ${t('reconcile.allDone', { month: long[month - 1] })}</span>`}</strong>
      </div>
      <div class="rc-totals">
        <div><div class="label"><${Dot} color=${INCOME_COLOR} size=${8} />${t('common.income')}</div>
          <div class="value">${money(income.actual)}</div><div class="small muted">${t('reconcile.ofBudget', { amount: money(income.planned) })}</div></div>
        <div><div class="label"><${Dot} color=${EXPENSE_COLOR} size=${8} />${t('common.expenses')}</div>
          <div class="value">${money(-expense.actual)}</div><div class="small muted">${t('reconcile.ofBudget', { amount: money(-expense.planned) })}</div></div>
        <div><div class="label">${expense.actual - expense.planned > 0.5 ? t('reconcile.overBudget') : t('reconcile.leftOfBudget')}</div>
          <div class=${'value ' + (expense.actual - expense.planned > 0.5 ? 'bad' : '')}>${money(Math.abs(expense.planned - expense.actual))}</div>
          <div class="small muted">${t('reconcile.expensesVsBudget')}</div></div>
      </div>
    </div>
    ${wide ? html`<div class="plan-cols"><div>${inboxCard}</div><div>${itemsCard}</div></div>` : html`${inboxCard}${itemsCard}`}
    ${choosing && html`<${Sheet} title=${txName(choosing)} onClose=${() => setChoosing(null)}>
      <${AssignView} tx=${choosing} items=${items} year=${year} onBack=${() => setChoosing(null)} onDone=${() => { setChoosing(null); onChanged(); }} />
    </${Sheet}>`}
    ${itemOpen && html`<${ItemBankSheet} item=${items.find((i) => i.id === itemOpen.id) || itemOpen} year=${year} month=${month}
      txs=${txs} items=${items} onClose=${() => setItemOpen(null)} onChanged=${onChanged} />`}
  </div>`;
}
