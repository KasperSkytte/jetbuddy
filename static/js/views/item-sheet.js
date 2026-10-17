import { html, useState, useRef, useEffect } from '../lib.js';
import { api } from '../api.js';
import { useStore, reloadHousehold } from '../store.js';
import { t } from '../i18n.js';
import { monthNames, parseAmount, amount, money, sum } from '../fmt.js';
import { Sheet, Segmented, Switch, Icon, toast, toastError } from '../ui.js';
import { members, categories, EVERY, applyPattern, detectPattern } from '../model.js';

/**
 * One month as a tile. It is a real text box (so a tap goes straight to the
 * keyboard on phones) that looks like a tile until focused. Enter moves on
 * to the next month.
 */
function MonthTile({ label, longLabel, value, onCommit }) {
  const [text, setText] = useState(amount(value));
  const [focused, setFocused] = useState(false);
  const skip = useRef(false);
  useEffect(() => {
    if (!focused) setText(amount(value));
  }, [value, focused]);
  const commit = () => {
    const v = parseAmount(text);
    if (skip.current || Number.isNaN(v)) {
      skip.current = false;
      setText(amount(value));
      return;
    }
    if (v !== (value ?? null)) onCommit(v);
  };
  const keydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const all = [...e.target.closest('.mtiles').querySelectorAll('input')];
      const next = all[all.indexOf(e.target) + 1];
      if (next) next.focus();
      else e.target.blur();
    } else if (e.key === 'Escape') {
      // Undo this month only; don't let the sheet close.
      e.preventDefault();
      e.stopPropagation();
      skip.current = true;
      e.target.blur();
    }
  };
  return html`<label class=${'mtile' + (value != null ? ' on' : '') + (focused ? ' editing' : '')}>
    <span class="m">${label}</span>
    <input type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" value=${text} placeholder="–" aria-label=${longLabel}
      class=${Number.isNaN(parseAmount(text)) ? 'invalid' : ''}
      onFocus=${(e) => { setFocused(true); requestAnimationFrame(() => e.target.select()); }}
      onBlur=${() => { setFocused(false); commit(); }}
      onInput=${(e) => setText(e.target.value)} onKeyDown=${keydown} />
  </label>`;
}

/**
 * Create or edit a budget item for one year. Pass item to edit, or member +
 * kind to create.
 */
export function ItemSheet({ year, item, member, kind, focusMonth, onClose, onChanged }) {
  const { household } = useStore();
  const isNew = !item;
  const start = item?.amounts || Array(12).fill(null);
  const detected = detectPattern(start);
  const hasValues = start.some((v) => v != null);

  const [form, setForm] = useState(() => ({
    name: item?.name || '',
    member_id: item?.member_id ?? member?.id,
    kind: item?.kind || kind || 'expense',
    category_id: item?.category_id ?? null,
    account_id: item?.account_id ?? null,
    fixed: item?.fixed || false,
    note: item?.note || '',
  }));
  const [values, setValues] = useState(start);
  // 'pattern': the amounts follow amount/every/from/to. 'custom': month by month.
  const [mode, setMode] = useState(hasValues && !detected ? 'custom' : 'pattern');
  const [pattern, setPattern] = useState(() => ({
    text: detected ? amount(detected.value) : '',
    every: detected?.every ?? 1,
    from: detected?.from ?? (isNew && focusMonth ? focusMonth - 1 : 0),
    to: detected?.to ?? 11,
  }));
  const [busy, setBusy] = useState(false);
  const short = monthNames('short');
  const long = monthNames('long');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const prev = item?.prev || Array(12).fill(null);
  const hasPrev = prev.some((v) => v != null);
  const patternValue = parseAmount(pattern.text);
  const invalid = mode === 'pattern' && Number.isNaN(patternValue);

  const updatePattern = (patch) => {
    const next = { ...pattern, ...patch };
    if (next.to < next.from) next.to = 11;
    setPattern(next);
    setMode('pattern');
    const v = parseAmount(next.text);
    if (!Number.isNaN(v)) setValues(applyPattern(next, v));
  };

  const chooseEvery = (value) => {
    if (value === 'custom') {
      setMode('custom');
      return;
    }
    // Coming from month by month: start from the most common amount.
    let text = pattern.text;
    if (mode === 'custom' && !text) {
      const counts = {};
      values.forEach((v) => v != null && (counts[v] = (counts[v] || 0) + 1));
      const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (common) text = amount(Number(common[0]));
    }
    updatePattern({ every: Number(value), text });
  };

  const editMonth = (i, v) => {
    const updated = values.map((x, k) => (k === i ? v : x));
    setValues(updated);
    const p = detectPattern(updated);
    if (p) {
      setPattern({ text: amount(p.value), every: p.every, from: p.from, to: p.to });
      setMode('pattern');
    } else if (updated.some((x) => x != null)) {
      setMode('custom');
    }
  };

  const copyPrev = () => {
    setValues(prev);
    const p = detectPattern(prev);
    if (p) {
      setPattern({ text: amount(p.value), every: p.every, from: p.from, to: p.to });
      setMode('pattern');
    } else setMode('custom');
  };

  const save = async () => {
    if (!form.name.trim() || invalid) return;
    setBusy(true);
    try {
      if (isNew) {
        await api.post('/api/items', { ...form, name: form.name.trim(), year, amounts: values });
      } else {
        await api.patch(`/api/items/${item.id}?year=${year}`, { ...form, name: form.name.trim() });
        await api.put(`/api/items/${item.id}/amounts`, { year, amounts: values });
      }
      onChanged();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (everywhere) => {
    const msg = everywhere ? t('item.confirmDeleteAll', { name: item.name }) : t('item.confirmRemoveYear', { name: item.name, year });
    if (!confirm(msg)) return;
    try {
      await api.del(`/api/items/${item.id}` + (everywhere ? '' : `?year=${year}`));
      toast(everywhere ? t('item.deleted') : t('item.removed', { year }));
      onChanged();
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  const addCategory = async () => {
    const name = prompt(t('settings.newCategory'));
    if (!name?.trim()) return;
    try {
      const c = await api.post('/api/categories', { name: name.trim(), kind: form.kind });
      await reloadHousehold();
      set({ category_id: c.id });
    } catch (e) {
      toastError(e);
    }
  };

  const cats = categories(household, form.kind);
  const savingsAccounts = household.accounts.filter((a) => a.kind === 'savings' && !a.archived);

  return html`<${Sheet} title=${isNew ? (form.kind === 'income' ? t('item.newIncome') : t('item.newExpense')) : item.name} onClose=${onClose}
    footer=${html`
      ${!isNew && html`<button class="btn ghost danger" onClick=${() => remove(false)}>${t('item.removeYear', { year })}</button>`}
      <span class="spacer"></span>
      <button class="btn" onClick=${onClose}>${t('common.cancel')}</button>
      <button class="btn primary" onClick=${save} disabled=${busy || !form.name.trim() || invalid}>${t('common.save')}</button>`}>
    <div class="form-grid">
      <label class="field"><span>${t('item.name')}</span>
        <input class="input" value=${form.name} onInput=${(e) => set({ name: e.target.value })} autofocus=${isNew} placeholder=${t('item.namePlaceholder')} maxlength="200" />
      </label>
      <div class="form-grid two">
        <div class="field"><span>${t('item.type')}</span>
          <${Segmented} value=${form.kind} onChange=${(kind) => set({ kind, category_id: null })}
            options=${[{ value: 'expense', label: t('common.expense') }, { value: 'income', label: t('common.incomeOne') }]} />
        </div>
        <label class="field"><span>${t('item.whose')}</span>
          <select class="input" value=${form.member_id} onChange=${(e) => set({ member_id: Number(e.target.value) })}>
            ${members(household).map((m) => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}
          </select>
        </label>
      </div>

      <div class="amount-box">
        <div class="form-grid two">
          ${mode === 'pattern' && html`<label class="field"><span>${t('item.amount')}</span>
            <input class="input big" type="text" inputmode="decimal" value=${pattern.text} placeholder="0"
              style=${invalid ? 'border-color:var(--bad)' : ''} onInput=${(e) => updatePattern({ text: e.target.value })} /></label>`}
          <label class="field"><span>${t('item.howOften')}</span>
            <select class="input" value=${mode === 'custom' ? 'custom' : pattern.every} onChange=${(e) => chooseEvery(e.target.value)}>
              ${EVERY.map((n) => html`<option key=${n} value=${n}>${t('item.every' + n)}</option>`)}
              <option value="custom">${t('item.varies')}</option>
            </select></label>
        </div>
        ${mode === 'pattern' && html`<div class="form-grid two" style="margin-top:14px">
          <label class="field"><span>${pattern.every === 12 ? t('item.inMonth') : t('item.from')}</span>
            <select class="input" value=${pattern.from} onChange=${(e) => updatePattern({ from: Number(e.target.value) })}>
              ${long.map((m, i) => html`<option key=${i} value=${i}>${m}</option>`)}</select></label>
          ${pattern.every !== 12 && html`<label class="field"><span>${t('item.until')}</span>
            <select class="input" value=${pattern.to} onChange=${(e) => updatePattern({ to: Number(e.target.value) })}>
              ${long.map((m, i) => i >= pattern.from && html`<option key=${i} value=${i}>${m}</option>`)}</select></label>`}
        </div>`}

        <div class="row" style="margin:16px 0 8px">
          <span class="spacer small secondary">${mode === 'custom' ? t('item.tapMonths') : t('item.tapToChange')}</span>
          <span class="small num"><span class="muted">${t('item.yearTotal', { year })}</span> <strong>${money(sum(values))}</strong></span>
        </div>
        <div class="mtiles">
          ${values.map((v, i) => html`<${MonthTile} key=${i} label=${short[i]} longLabel=${long[i]} value=${v} onCommit=${(val) => editMonth(i, val)} />`)}
        </div>
        ${hasPrev && html`<button class="btn small" style="margin-top:12px" onClick=${copyPrev}><${Icon} name="copy" size=${16} />${t('item.copyPrev', { year: year - 1 })}</button>`}
      </div>

      <div class="form-grid two">
        <label class="field"><span>${t('item.category')}</span>
          <div class="row">
            <select class="input" value=${form.category_id ?? ''} onChange=${(e) => set({ category_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">${t('common.uncategorized')}</option>
              ${cats.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
            </select>
            <button class="btn icon" type="button" onClick=${addCategory} aria-label=${t('settings.newCategory')}><${Icon} name="plus" size=${18} /></button>
          </div>
        </label>
        ${savingsAccounts.length > 0 && html`<label class="field"><span>${form.kind === 'expense' ? t('item.toAccount') : t('item.fromAccount')}</span>
          <select class="input" value=${form.account_id ?? ''} onChange=${(e) => set({ account_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">${t('item.noAccount')}</option>
            ${savingsAccounts.map((a) => html`<option key=${a.id} value=${a.id}>${a.name}</option>`)}
          </select>
          <span class="hint">${form.kind === 'expense' ? t('item.toAccountHint') : t('item.fromAccountHint')}</span>
        </label>`}
      </div>
      <${Switch} checked=${form.fixed} onChange=${(fixed) => set({ fixed })} label=${t('item.fixed')} hint=${t('item.fixedHint')} />
      <label class="field"><span>${t('item.note')}</span>
        <textarea class="input" value=${form.note} onInput=${(e) => set({ note: e.target.value })} placeholder=${t('item.notePlaceholder')} maxlength="2000"></textarea>
      </label>
      ${!isNew && html`<button class="btn ghost danger small" style="align-self:flex-start" onClick=${() => remove(true)}><${Icon} name="trash" size=${16} />${t('item.deleteAll')}</button>`}
    </div>
  </${Sheet}>`;
}
