import { html, useState, useEffect } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, setStore, bump, reloadHousehold } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, monthNames, sum, amount, parseAmount } from '../fmt.js';
import { AmountInput, Chips, Dot, Icon, Segmented, Empty, seriesColor, toast, toastError } from '../ui.js';
import { members, itemsOf, categoryById, accountById, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
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

function useWide() {
  const query = '(min-width: 900px)';
  const [wide, setWide] = useState(matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const fn = () => setWide(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return wide;
}

// ------------------------------------------------------------------ phone list

function ItemCard({ item, household, onOpen, reorder, onMove, color }) {
  const category = categoryById(household, item.category_id);
  const account = accountById(household, item.account_id);
  const meta = [category?.name, account && '→ ' + account.name].filter(Boolean).join(' · ');
  const filled = item.amounts.filter((v) => v != null).length;
  return html`<div class="list-row tap" onClick=${() => !reorder && onOpen(item)}>
    <div class="main-col">
      <div class="row" style="gap:6px"><span class="name">${item.name}</span>
        ${item.fixed && html`<span class="badge" title=${t('item.fixed')}><${Icon} name="repeat" size=${11} stroke=${2.2} /></span>`}
        ${item.note && html`<span class="muted"><${Icon} name="note" size=${13} /></span>`}</div>
      <div class="meta">${meta || (filled ? t('plan.months', { n: filled }) : t('plan.noAmounts'))}</div>
      <div class="month-strip" style=${{ '--strip': color }} aria-hidden="true">${item.amounts.map((v, i) => html`<span key=${i} class=${v != null && v !== 0 ? 'on' : ''}></span>`)}</div>
    </div>
    ${reorder
      ? html`<div class="row" style="gap:2px">
          <button class="btn ghost icon small" onClick=${(e) => { e.stopPropagation(); onMove(-1); }} aria-label=${t('plan.moveUp')}><${Icon} name="up" size=${18} /></button>
          <button class="btn ghost icon small" onClick=${(e) => { e.stopPropagation(); onMove(1); }} aria-label=${t('plan.moveDown')}><${Icon} name="down" size=${18} /></button></div>`
      : html`<div class="amount">${money(sum(item.amounts))}</div>`}
  </div>`;
}

function ListView({ items, household, onOpen, onAdd, reorder, onMove }) {
  return ['income', 'expense'].map((kind) => {
    const list = items.filter((i) => i.kind === kind);
    const color = kind === 'income' ? INCOME_COLOR : EXPENSE_COLOR;
    return html`<section class="card flush" key=${kind} style="margin-bottom:12px">
      <div class="group-label" style="padding-top:14px">${kind === 'income' ? t('common.income') : t('common.expenses')}
        <span class="total">${money(sum(list.map((i) => sum(i.amounts))))}</span></div>
      <div class="list">${list.map((item, idx) => html`<${ItemCard} key=${item.id} item=${item} household=${household} color=${color}
        onOpen=${onOpen} reorder=${reorder} onMove=${(d) => onMove(list, idx, d)} />`)}</div>
      <button class="add-row" onClick=${() => onAdd(kind)}><${Icon} name="plus" size=${18} />${kind === 'income' ? t('plan.addIncome') : t('plan.addExpense')}</button>
    </section>`;
  });
}

// ------------------------------------------------------------------ desktop grid

function focusCell(r, c) {
  const el = document.querySelector(`input.cell[data-r="${r}"][data-c="${c}"]`);
  if (el) el.focus();
  return !!el;
}

function GridView({ items, year, onOpen, onAdd, onCell, onPaste }) {
  const short = monthNames('short');
  const sections = ['income', 'expense'].map((kind) => ({ kind, list: items.filter((i) => i.kind === kind) }));
  let r = 0;
  const rowIndex = new Map();
  for (const s of sections) for (const i of s.list) rowIndex.set(i.id, r++);

  const onKeyDown = (e) => {
    const el = e.target;
    if (!el.classList.contains('cell')) return;
    const row = Number(el.dataset.r);
    const col = Number(el.dataset.c);
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length;
    const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length;
    let moved = false;
    if (e.key === 'Enter' || e.key === 'ArrowDown') moved = focusCell(row + (e.shiftKey && e.key === 'Enter' ? -1 : 1), col);
    else if (e.key === 'ArrowUp') moved = focusCell(row - 1, col);
    else if (e.key === 'ArrowLeft' && (atStart || allSelected)) moved = focusCell(row, col - 1);
    else if (e.key === 'ArrowRight' && (atEnd || allSelected)) moved = focusCell(row, col + 1);
    else return;
    if (moved || e.key === 'Enter') e.preventDefault();
    if (!moved && e.key === 'Enter') el.blur();
  };

  // Paste a block of cells copied from a spreadsheet, starting at the focused cell.
  const paste = (e) => {
    const el = e.target;
    if (!el.classList?.contains('cell')) return;
    const text = e.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const block = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));
    onPaste(Number(el.dataset.r), Number(el.dataset.c), block);
  };

  const monthTotal = (list, m) => sum(list.map((i) => i.amounts[m]));
  return html`<section class="card flush">
    <div class="grid-wrap" onKeyDown=${onKeyDown} onPaste=${paste}>
      <table class="sheet">
        <thead><tr><th>${year}</th>${short.map((m) => html`<th key=${m}>${m}</th>`)}<th style="padding-right:16px">${t('common.total')}</th></tr></thead>
        ${sections.map((s) => html`<tbody key=${s.kind}>
          <tr class="section"><td colspan="14"><span class="row"><${Dot} color=${s.kind === 'income' ? INCOME_COLOR : EXPENSE_COLOR} size=${8} />
            ${s.kind === 'income' ? t('common.income') : t('common.expenses')}</span></td></tr>
          ${s.list.map((item) => html`<tr key=${item.id}>
            <td class="name"><button onClick=${() => onOpen(item)} title=${item.note || item.name}>
              <span class="label ellipsis">${item.name}</span>
              ${item.fixed && html`<span class="badge"><${Icon} name="repeat" size=${11} stroke=${2.2} /></span>`}
              ${item.note && html`<span class="muted"><${Icon} name="note" size=${13} /></span>`}</button></td>
            ${item.amounts.map((v, m) => html`<td key=${m}><${AmountInput} className="cell" value=${v} label=${item.name + ' ' + short[m]}
              onSave=${(value) => onCell(item, m, value)} placeholder="" nav=${false} data=${{ r: rowIndex.get(item.id), c: m }} /></td>`)}
            <td class="total">${amount(sum(item.amounts)) || '–'}</td>
          </tr>`)}
          <tr><td colspan="14" style="padding:0"><button class="add-row" style="border-top:0" onClick=${() => onAdd(s.kind)}>
            <${Icon} name="plus" size=${18} />${s.kind === 'income' ? t('plan.addIncome') : t('plan.addExpense')}</button></td></tr>
        </tbody>`)}
        <tfoot>
          ${sections.map((s) => html`<tr key=${s.kind}><td>${s.kind === 'income' ? t('common.income') : t('common.expenses')}</td>
            ${short.map((_, m) => html`<td key=${m}>${amount(monthTotal(s.list, m)) || '–'}</td>`)}
            <td>${amount(sum(s.list.map((i) => sum(i.amounts))))}</td></tr>`)}
          <tr><td>${t('common.balance')}</td>
            ${short.map((_, m) => {
              const v = monthTotal(sections[0].list, m) - monthTotal(sections[1].list, m);
              return html`<td key=${m} class=${v > 0.5 ? 'good' : v < -0.5 ? 'bad' : ''}>${amount(Math.round(v * 100) / 100) || '–'}</td>`;
            })}
            <td>${amount(Math.round((sum(sections[0].list.map((i) => sum(i.amounts))) - sum(sections[1].list.map((i) => sum(i.amounts)))) * 100) / 100)}</td></tr>
        </tfoot>
      </table>
    </div>
  </section>`;
}

// ------------------------------------------------------------------ page

export function Plan() {
  const store = useStore();
  const { year, household } = store;
  const items = useData(`/api/years/${year}/items`);
  const wide = useWide();
  const [layout, setLayout] = useState('auto');
  const [editing, setEditing] = useState(null);
  const [reorder, setReorder] = useState(false);
  const people = members(household);
  const memberId = people.some((m) => m.id === store.planMember) ? store.planMember : people[0]?.id;
  const member = people.find((m) => m.id === memberId);
  const list = items.stale || !items.data ? null : itemsOf(items.data, memberId);
  const showGrid = layout === 'grid' || (layout === 'auto' && wide);

  const updateLocal = (id, amounts) => items.set((all) => all.map((i) => (i.id === id ? { ...i, amounts } : i)));

  const onCell = async (item, m, value) => {
    await api.put(`/api/items/${item.id}/amount`, { year, month: m + 1, amount: value });
    const current = items.data.find((i) => i.id === item.id);
    updateLocal(item.id, current.amounts.map((v, k) => (k === m ? value : v)));
  };

  const onPaste = async (row0, col0, block) => {
    const ordered = [...list.filter((i) => i.kind === 'income'), ...list.filter((i) => i.kind === 'expense')];
    let bad = 0;
    try {
      for (let r = 0; r < block.length; r++) {
        const item = ordered[row0 + r];
        if (!item) break;
        const amounts = [...item.amounts];
        block[r].forEach((cell, c) => {
          const m = col0 + c;
          if (m > 11) return;
          const v = parseAmount(cell);
          if (Number.isNaN(v)) bad++;
          else amounts[m] = v == null ? null : Math.abs(v);
        });
        await api.put(`/api/items/${item.id}/amounts`, { year, amounts });
        updateLocal(item.id, amounts);
      }
      toast(bad ? t('plan.pastedSome', { n: bad }) : t('plan.pasted'));
    } catch (e) {
      toastError(e);
    }
  };

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
        <div class="row">
          ${wide && html`<${Segmented} label=${t('plan.layout')} value=${showGrid ? 'grid' : 'list'} onChange=${setLayout}
            options=${[{ value: 'grid', label: t('plan.grid') }, { value: 'list', label: t('plan.list') }]} />`}
          ${!showGrid && html`<button class=${'btn small' + (reorder ? ' primary' : '')} onClick=${() => setReorder(!reorder)}>
            ${reorder ? html`<${Icon} name="check" size=${16} />${t('common.done')}` : t('plan.reorder')}</button>`}
        </div>
      </div>
      ${member?.is_shared && html`<p class="small muted" style="margin:10px 0 0">${t('plan.sharedHint')}</p>`}
    </div>
    ${!list ? html`<div class="loading">${t('common.loading')}</div>`
      : showGrid ? html`<${GridView} items=${list} year=${year} onOpen=${(item) => setEditing({ item })}
          onAdd=${(kind) => setEditing({ member, kind })} onCell=${onCell} onPaste=${onPaste} />
          <p class="small muted">${t('plan.gridHint')}</p>`
      : html`<${ListView} items=${list} household=${household} onOpen=${(item) => setEditing({ item })}
          onAdd=${(kind) => setEditing({ member, kind })} reorder=${reorder} onMove=${onMove} />`}
    ${editing && html`<${ItemSheet} year=${year} item=${editing.item} member=${editing.member} kind=${editing.kind}
      onClose=${() => setEditing(null)} onChanged=${() => items.reload()} />`}
  </div>`;
}
