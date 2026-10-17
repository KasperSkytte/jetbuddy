import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { useStore, reloadHousehold } from '../store.js';
import { t } from '../i18n.js';
import { monthNames, parseAmount, amount, money, sum } from '../fmt.js';
import { Sheet, Segmented, Switch, Icon, toast, toastError } from '../ui.js';
import { members, categories } from '../model.js';

const EVERY = [1, 2, 3, 4, 6, 12];

/**
 * Create or edit a budget item for one year. Pass item to edit, or member +
 * kind to create.
 */
export function ItemSheet({ year, item, member, kind, focusMonth, onClose, onChanged }) {
  const { household } = useStore();
  const isNew = !item;
  const [form, setForm] = useState(() => ({
    name: item?.name || '',
    member_id: item?.member_id ?? member?.id,
    kind: item?.kind || kind || 'expense',
    category_id: item?.category_id ?? null,
    account_id: item?.account_id ?? null,
    fixed: item?.fixed || false,
    note: item?.note || '',
  }));
  const [texts, setTexts] = useState(() => (item?.amounts || Array(12).fill(null)).map(amount));
  const [fill, setFill] = useState({ amount: '', every: 1, from: (focusMonth || 1) - 1 });
  const [busy, setBusy] = useState(false);
  const short = monthNames('short');
  const long = monthNames('long');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const parsed = texts.map(parseAmount);
  const invalid = parsed.some(Number.isNaN);
  const prev = item?.prev || Array(12).fill(null);
  const hasPrev = prev.some((v) => v != null);

  const applyFill = () => {
    const value = parseAmount(fill.amount);
    if (value == null || Number.isNaN(value)) return;
    // Months before the start month are kept; from there on, the pattern
    // months get the amount and the months in between are cleared.
    setTexts((old) => old.map((txt, i) => (i < fill.from ? txt : (i - fill.from) % fill.every === 0 ? amount(value) : '')));
  };

  const save = async () => {
    if (!form.name.trim() || invalid) return;
    setBusy(true);
    try {
      if (isNew) {
        await api.post('/api/items', { ...form, name: form.name.trim(), year, amounts: parsed });
      } else {
        await api.patch(`/api/items/${item.id}?year=${year}`, { ...form, name: form.name.trim() });
        await api.put(`/api/items/${item.id}/amounts`, { year, amounts: parsed });
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
  const total = sum(parsed.filter((v) => !Number.isNaN(v)));

  return html`<${Sheet} wide title=${isNew ? (form.kind === 'income' ? t('item.newIncome') : t('item.newExpense')) : item.name} onClose=${onClose}
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

      <div class="field">
        <div class="row"><span class="spacer" style="font-size:13px;font-weight:560;color:var(--text-2)">${t('item.amountsFor', { year })}</span>
          <span class="small num"><span class="muted">${t('common.total')}</span> <strong>${money(total)}</strong></span></div>
        <div class="months-grid">
          ${texts.map((txt, i) => html`<label key=${i}>
            <span>${short[i]}</span>
            <input class=${'input' + (Number.isNaN(parsed[i]) ? ' invalid' : '')} style=${Number.isNaN(parsed[i]) ? 'border-color:var(--bad)' : ''}
              type="text" inputmode="decimal" enterkeyhint="next" value=${txt} aria-label=${long[i]} placeholder="–"
              onInput=${(e) => setTexts((old) => old.map((x, k) => (k === i ? e.target.value : x)))}
              onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); const all = e.target.closest('.months-grid').querySelectorAll('input'); (all[i + 1] || e.target).focus(); } }} />
            <div class="prev">${prev[i] != null ? `${year - 1}: ${amount(prev[i])}` : ''}</div>
          </label>`)}
        </div>
      </div>

      <div class="fill-box">
        <strong class="full small">${t('item.quickFill')}</strong>
        <label class="field"><span>${t('item.fillAmount')}</span>
          <input class="input" type="text" inputmode="decimal" value=${fill.amount} onInput=${(e) => setFill({ ...fill, amount: e.target.value })} placeholder="0" />
        </label>
        <label class="field"><span>${t('item.fillEvery')}</span>
          <select class="input" value=${fill.every} onChange=${(e) => setFill({ ...fill, every: Number(e.target.value) })}>
            ${EVERY.map((n) => html`<option key=${n} value=${n}>${t('item.every' + n)}</option>`)}
          </select>
        </label>
        <label class="field"><span>${t('item.fillFrom')}</span>
          <select class="input" value=${fill.from} onChange=${(e) => setFill({ ...fill, from: Number(e.target.value) })}>
            ${long.map((m, i) => html`<option key=${i} value=${i}>${m}</option>`)}
          </select>
        </label>
        <div class="field" style="justify-content:flex-end">
          <button class="btn primary" onClick=${applyFill} disabled=${parseAmount(fill.amount) == null || Number.isNaN(parseAmount(fill.amount))}>${t('item.fillApply')}</button>
        </div>
        <div class="full row wrap">
          ${hasPrev && html`<button class="btn small" onClick=${() => setTexts(prev.map(amount))}><${Icon} name="copy" size=${16} />${t('item.copyPrev', { year: year - 1 })}</button>`}
          <button class="btn small" onClick=${() => setTexts(Array(12).fill(''))}>${t('item.clear')}</button>
        </div>
        <p class="full small muted" style="margin:0">${t('item.fillHint')}</p>
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
