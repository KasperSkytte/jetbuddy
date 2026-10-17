import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, setStore, bump, reloadHousehold } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, sum } from '../fmt.js';
import { Chips, Dot, Icon, seriesColor, toast, toastError } from '../ui.js';
import { members, itemsOf, categoryById, accountById, describeAmounts, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
import { ItemSheet } from './item-sheet.js';

/** Offer to start an empty year from the year before. */
export function CopyYearBanner({ year }) {
  const prev = useData(`/api/years/${year - 1}/items`);
  const [busy, setBusy] = useState(false);
  if (!prev.data?.length || prev.stale) return null;
  const copy = async (amounts) => {
    setBusy(true);
    try {
      const r = await api.post(`/api/years/${year}/copy`, { from_year: year - 1, amounts });
      toast(t('plan.copied', { n: r.copied }));
      await reloadHousehold();
      bump();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="banner">
    <div class="text"><strong>${t('plan.startFrom', { year, prev: year - 1 })}</strong>
      <div class="small secondary">${t('plan.startFromHint', { n: prev.data.length })}</div></div>
    <div class="row wrap">
      <button class="btn primary" disabled=${busy} onClick=${() => copy(true)}><${Icon} name="copy" size=${18} />${t('plan.copyAll')}</button>
      <button class="btn" disabled=${busy} onClick=${() => copy(false)}>${t('plan.copyItems')}</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ item list

function ItemCard({ item, household, onOpen, reorder, onMove, color }) {
  const category = categoryById(household, item.category_id);
  const account = accountById(household, item.account_id);
  const meta = [describeAmounts(item.amounts), category?.name, account && '→ ' + account.name].filter(Boolean).join(' · ');
  return html`<div class="list-row tap item-row" onClick=${() => !reorder && onOpen(item)}>
    <div class="main-col">
      <div class="row" style="gap:6px"><span class="name">${item.name}</span>
        ${item.fixed && html`<span class="badge" title=${t('item.fixed')}><${Icon} name="repeat" size=${11} stroke=${2.2} /></span>`}
        ${item.note && html`<span class="muted"><${Icon} name="note" size=${13} /></span>`}</div>
      <div class="meta">${meta}</div>
    </div>
    ${reorder
      ? html`<div class="row" style="gap:2px">
          <button class="btn ghost icon small" onClick=${(e) => { e.stopPropagation(); onMove(-1); }} aria-label=${t('plan.moveUp')}><${Icon} name="up" size=${18} /></button>
          <button class="btn ghost icon small" onClick=${(e) => { e.stopPropagation(); onMove(1); }} aria-label=${t('plan.moveDown')}><${Icon} name="down" size=${18} /></button></div>`
      : html`<div class="amount">${money(sum(item.amounts))}</div>`}
    <div class="month-strip" style=${{ '--strip': color }} aria-hidden="true">${item.amounts.map((v, i) => html`<span key=${i} class=${v != null && v !== 0 ? 'on' : ''}></span>`)}</div>
  </div>`;
}

function ListView({ items, household, onOpen, onAdd, reorder, onMove }) {
  return html`<div class="plan-cols">${['income', 'expense'].map((kind) => {
    const list = items.filter((i) => i.kind === kind);
    const color = kind === 'income' ? INCOME_COLOR : EXPENSE_COLOR;
    return html`<section class="card flush" key=${kind}>
      <div class="group-label" style="padding-top:14px">${kind === 'income' ? t('common.income') : t('common.expenses')}
        <span class="total">${money(sum(list.map((i) => sum(i.amounts))))}</span></div>
      <div class="list">${list.map((item, idx) => html`<${ItemCard} key=${item.id} item=${item} household=${household} color=${color}
        onOpen=${onOpen} reorder=${reorder} onMove=${(d) => onMove(list, idx, d)} />`)}</div>
      <button class="add-row" onClick=${() => onAdd(kind)}><${Icon} name="plus" size=${18} />${kind === 'income' ? t('plan.addIncome') : t('plan.addExpense')}</button>
    </section>`;
  })}</div>`;
}

// ------------------------------------------------------------------ page

export function Plan() {
  const store = useStore();
  const { year, household } = store;
  const items = useData(`/api/years/${year}/items`);
  const [editing, setEditing] = useState(null);
  const [reorder, setReorder] = useState(false);
  const people = members(household);
  const memberId = people.some((m) => m.id === store.planMember) ? store.planMember : people[0]?.id;
  const member = people.find((m) => m.id === memberId);
  const list = items.stale || !items.data ? null : itemsOf(items.data, memberId);

  const onMove = async (section, idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= section.length) return;
    const ids = section.map((i) => i.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    try {
      await api.post('/api/items/order', { ids });
      items.reload();
    } catch (e) {
      toastError(e);
    }
  };

  const income = list ? sum(list.filter((i) => i.kind === 'income').map((i) => sum(i.amounts))) : 0;
  const expense = list ? sum(list.filter((i) => i.kind === 'expense').map((i) => sum(i.amounts))) : 0;

  return html`<div>
    <div style="margin-bottom:12px">
      <${Chips} label=${t('plan.whose')} value=${memberId} onChange=${(v) => setStore({ planMember: v })}
        options=${people.map((m) => ({ value: m.id, label: m.name, color: seriesColor(m.color) }))} />
    </div>
    ${items.data && items.data.length === 0 && !items.stale && html`<${CopyYearBanner} year=${year} />`}
    <div class="card" style="margin-bottom:12px">
      <div class="row wrap" style="row-gap:12px">
        <div class="sum-strip spacer" style="min-width:min(100%, 420px)">
          <div><div class="label"><${Dot} color=${INCOME_COLOR} size=${8} />${t('common.income')}</div><div class="value">${money(income)}</div></div>
          <div><div class="label"><${Dot} color=${EXPENSE_COLOR} size=${8} />${t('common.expenses')}</div><div class="value">${money(expense)}</div></div>
          <div><div class="label">${t('common.balance')}</div><div class=${'value ' + (income - expense > 0.5 ? 'good' : income - expense < -0.5 ? 'bad' : '')}>${signedMoney(income - expense)}</div></div>
        </div>
        <button class=${'btn small' + (reorder ? ' primary' : '')} onClick=${() => setReorder(!reorder)}>
          ${reorder ? html`<${Icon} name="check" size=${16} />${t('common.done')}` : t('plan.reorder')}</button>
      </div>
      ${member?.is_shared && html`<p class="small muted" style="margin:10px 0 0">${t('plan.sharedHint')}</p>`}
    </div>
    ${!list ? html`<div class="loading">${t('common.loading')}</div>`
      : html`<${ListView} items=${list} household=${household} onOpen=${(item) => setEditing({ item })}
          onAdd=${(kind) => setEditing({ member, kind })} reorder=${reorder} onMove=${onMove} />`}
    ${editing && html`<${ItemSheet} year=${year} item=${editing.item} member=${editing.member} kind=${editing.kind}
      onClose=${() => setEditing(null)} onChanged=${() => items.reload()} />`}
  </div>`;
}
