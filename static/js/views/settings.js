import { html, useState } from '../lib.js';
import { api, request } from '../api.js';
import { useStore, setStore, reloadHousehold, applyTheme, bump, useData, applySettings } from '../store.js';
import { t, LANGUAGES } from '../i18n.js';
import { money, monthNames } from '../fmt.js';
import { Sheet, Swatches, Switch, Segmented, Dot, Icon, seriesColor, toast, toastError } from '../ui.js';
import { categories } from '../model.js';
import { ImportSheet } from './import.js';

export const LOCALES = ['en-US', 'en-GB', 'da-DK', 'de-DE', 'de-CH', 'sv-SE', 'nb-NO', 'fi-FI', 'nl-NL', 'fr-FR', 'es-ES', 'it-IT', 'pl-PL'];
export const CURRENCIES = ['DKK', 'EUR', 'USD', 'GBP', 'SEK', 'NOK', 'ISK', 'CHF', 'PLN', 'CZK', 'CAD', 'AUD', 'NZD', 'JPY', 'INR', 'BRL', 'ZAR'];

export function localeExample(loc) {
  try {
    return new Intl.NumberFormat(loc, { minimumFractionDigits: 2 }).format(1234.56);
  } catch {
    return loc;
  }
}

async function run(fn, done) {
  try {
    await fn();
    await reloadHousehold();
    done?.();
  } catch (e) {
    toastError(e);
  }
}

function Section({ title, icon, children, action }) {
  return html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head">${icon && html`<${Icon} name=${icon} />`}<h2>${title}</h2>${action}</div>
    ${children}
  </section>`;
}

function HouseholdForm() {
  const { household, theme } = useStore();
  const s = household.settings;
  const [form, setForm] = useState({ household: s.household || '', language: s.language || 'en', locale: s.locale || 'en-US', currency: s.currency || 'USD' });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = Object.keys(form).some((k) => form[k] !== (s[k] || ''));
  const save = () => run(async () => {
    const settings = await api.put('/api/settings', form);
    applySettings(settings);
  }, () => toast(t('common.saved')));
  return html`<${Section} title=${t('settings.household')} icon="egg">
    <div class="form-grid two" style="padding:6px 16px 16px">
      <label class="field"><span>${t('settings.householdName')}</span>
        <input class="input" value=${form.household} onInput=${(e) => set({ household: e.target.value })} maxlength="100" /></label>
      <label class="field"><span>${t('settings.language')}</span>
        <select class="input" value=${form.language} onChange=${(e) => set({ language: e.target.value })}>
          ${Object.entries(LANGUAGES).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}</select></label>
      <label class="field"><span>${t('settings.currency')}</span>
        <select class="input" value=${form.currency} onChange=${(e) => set({ currency: e.target.value })}>
          ${(CURRENCIES.includes(form.currency) ? CURRENCIES : [form.currency, ...CURRENCIES]).map((c) => html`<option key=${c} value=${c}>${c}</option>`)}</select></label>
      <label class="field"><span>${t('settings.numberFormat')}</span>
        <select class="input" value=${form.locale} onChange=${(e) => set({ locale: e.target.value })}>
          ${(LOCALES.includes(form.locale) ? LOCALES : [form.locale, ...LOCALES]).map((l) => html`<option key=${l} value=${l}>${localeExample(l)} (${l})</option>`)}</select></label>
      <div class="field"><span>${t('settings.theme')}</span>
        <${Segmented} value=${theme} onChange=${(v) => { setStore({ theme: v }); applyTheme(v); }}
          options=${[{ value: 'auto', label: t('settings.themeAuto') }, { value: 'light', label: t('settings.themeLight') }, { value: 'dark', label: t('settings.themeDark') }]} /></div>
      <div class="field" style="justify-content:flex-end;align-items:flex-start">
        <button class="btn primary" disabled=${!dirty || !form.household.trim()} onClick=${save}>${t('common.save')}</button></div>
    </div>
  </${Section}>`;
}

function MemberSheet({ member, onClose }) {
  const isNew = !member;
  const [name, setName] = useState(member?.name || '');
  const [color, setColor] = useState(member?.color ?? 0);
  const [archived, setArchived] = useState(member?.archived || false);
  const save = () => run(
    () => (isNew ? api.post('/api/members', { name: name.trim(), color }) : api.patch(`/api/members/${member.id}`, { name: name.trim(), color, archived })),
    () => { bump(); onClose(); },
  );
  const remove = () => {
    if (!confirm(t('settings.confirmDeletePerson', { name: member.name }))) return;
    run(() => api.del(`/api/members/${member.id}`), onClose);
  };
  return html`<${Sheet} title=${isNew ? t('settings.addPerson') : member.name} onClose=${onClose}
    footer=${html`${!isNew && !member.is_shared && html`<button class="btn ghost danger" onClick=${remove}>${t('common.delete')}</button>`}
      <span class="spacer"></span><button class="btn" onClick=${onClose}>${t('common.cancel')}</button>
      <button class="btn primary" disabled=${!name.trim()} onClick=${save}>${t('common.save')}</button>`}>
    <div class="form-grid">
      <label class="field"><span>${t('settings.name')}</span><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} autofocus maxlength="60" /></label>
      <div class="field"><span>${t('common.color')}</span><${Swatches} value=${color} onChange=${setColor} /></div>
      ${!isNew && !member.is_shared && html`<${Switch} checked=${archived} onChange=${setArchived} label=${t('settings.archived')} hint=${t('settings.archivedHint')} />`}
      ${member?.is_shared && html`<p class="small muted" style="margin:0">${t('settings.sharedHint')}</p>`}
    </div>
  </${Sheet}>`;
}

function People() {
  const { household } = useStore();
  const [editing, setEditing] = useState(null);
  const list = household.members;
  const move = (idx, dir) => {
    const people = list.filter((m) => !m.is_shared);
    const j = idx + dir;
    if (j < 0 || j >= people.length) return;
    const ids = people.map((m) => m.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    run(() => api.post('/api/members/order', { ids }));
  };
  return html`<${Section} title=${t('settings.people')} icon="people">
    <p class="small secondary" style="margin:0;padding:0 16px 8px">${t('settings.peopleHint')}</p>
    <div class="list">${list.map((m, idx) => html`<div class="list-row tap" key=${m.id} onClick=${() => setEditing({ member: m })}>
      <${Dot} color=${seriesColor(m.color)} size=${12} />
      <div class="main-col"><div class="name">${m.name}</div>
        <div class="meta">${m.is_shared ? t('settings.sharedLabel') : m.archived ? t('settings.archived') : ''}</div></div>
      ${!m.is_shared && html`<button class="btn ghost icon small" onClick=${(e) => { e.stopPropagation(); move(idx, -1); }} aria-label=${t('plan.moveUp')}><${Icon} name="up" size=${18} /></button>
        <button class="btn ghost icon small" onClick=${(e) => { e.stopPropagation(); move(idx, 1); }} aria-label=${t('plan.moveDown')}><${Icon} name="down" size=${18} /></button>`}
    </div>`)}</div>
    <button class="add-row" onClick=${() => setEditing({})}><${Icon} name="plus" size=${18} />${t('settings.addPerson')}</button>
    ${editing && html`<${MemberSheet} member=${editing.member} onClose=${() => setEditing(null)} />`}
  </${Section}>`;
}

function Categories() {
  const { household } = useStore();
  const add = (kind) => {
    const name = prompt(t('settings.newCategory'));
    if (name?.trim()) run(() => api.post('/api/categories', { name: name.trim(), kind }));
  };
  const rename = (c) => {
    const name = prompt(t('settings.renameCategory'), c.name);
    if (name?.trim() && name !== c.name) run(() => api.patch(`/api/categories/${c.id}`, { name: name.trim() }));
  };
  const remove = (c) => {
    if (confirm(t('settings.confirmDeleteCategory', { name: c.name }))) run(() => api.del(`/api/categories/${c.id}`), bump);
  };
  return html`<${Section} title=${t('settings.categories')} icon="tag">
    ${['expense', 'income'].map((kind) => html`<div key=${kind}>
      <div class="group-label">${kind === 'income' ? t('common.income') : t('common.expenses')}</div>
      <div class="list">${categories(household, kind).map((c) => html`<div class="list-row" key=${c.id} style="min-height:48px">
        <div class="main-col tap" onClick=${() => rename(c)}><div class="name" style="font-weight:500">${c.name}</div></div>
        <button class="btn ghost icon small" onClick=${() => rename(c)} aria-label=${t('common.rename')}><${Icon} name="edit" size=${17} /></button>
        <button class="btn ghost icon small" onClick=${() => remove(c)} aria-label=${t('common.delete')}><${Icon} name="trash" size=${17} /></button>
      </div>`)}</div>
      <button class="add-row" onClick=${() => add(kind)}><${Icon} name="plus" size=${18} />${t('settings.addCategory')}</button>
    </div>`)}
  </${Section}>`;
}

function AccountSheet({ account, onClose }) {
  const isNew = !account;
  const { household } = useStore();
  const hasMain = household.accounts.some((a) => a.kind === 'main' && a.id !== account?.id);
  const [form, setForm] = useState({ name: account?.name || '', kind: account?.kind || (hasMain ? 'savings' : 'main'), color: account?.color ?? household.accounts.length % 8, archived: account?.archived || false });
  const balances = useData(account ? `/api/accounts/${account.id}/balances` : null);
  const long = monthNames('long');
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  const save = () => run(
    () => (isNew ? api.post('/api/accounts', form) : api.patch(`/api/accounts/${account.id}`, form)),
    () => { bump(); onClose(); },
  );
  const remove = () => {
    if (confirm(t('settings.confirmDeleteAccount', { name: account.name }))) run(() => api.del(`/api/accounts/${account.id}`), () => { bump(); onClose(); });
  };
  const clearBalance = (b) => run(() => api.put(`/api/accounts/${account.id}/balance`, { year: b.year, month: b.month, amount: null }), () => { balances.reload(); bump(); });
  return html`<${Sheet} title=${isNew ? t('settings.addAccount') : account.name} onClose=${onClose}
    footer=${html`${!isNew && html`<button class="btn ghost danger" onClick=${remove}>${t('common.delete')}</button>`}
      <span class="spacer"></span><button class="btn" onClick=${onClose}>${t('common.cancel')}</button>
      <button class="btn primary" disabled=${!form.name.trim()} onClick=${save}>${t('common.save')}</button>`}>
    <div class="form-grid">
      <label class="field"><span>${t('settings.name')}</span><input class="input" value=${form.name} onInput=${(e) => set({ name: e.target.value })} autofocus maxlength="60" /></label>
      <div class="field"><span>${t('settings.accountType')}</span>
        <${Segmented} value=${form.kind} onChange=${(kind) => set({ kind })}
          options=${[{ value: 'main', label: t('settings.mainAccount') }, { value: 'savings', label: t('settings.savingsAccount') }]} />
        <span class="hint">${form.kind === 'main' ? t('settings.mainHint') : t('settings.savingsHint')}</span>
        ${form.kind === 'main' && hasMain && html`<span class="hint bad">${t('settings.oneMain')}</span>`}</div>
      <div class="field"><span>${t('common.color')}</span><${Swatches} value=${form.color} onChange=${(color) => set({ color })} /></div>
      ${!isNew && html`<${Switch} checked=${form.archived} onChange=${(archived) => set({ archived })} label=${t('settings.archived')} hint=${t('settings.accountArchivedHint')} />`}
      ${!isNew && html`<div class="field"><span>${t('settings.actualBalances')}</span>
        <span class="hint">${t('settings.actualBalancesHint')}</span>
        ${balances.data?.length ? html`<div class="list" style="border:1px solid var(--border);border-radius:12px">
          ${balances.data.map((b) => html`<div class="list-row" key=${b.year + '-' + b.month} style="min-height:44px">
            <div class="main-col" style="text-transform:capitalize">${long[b.month - 1]} ${b.year}</div>
            <span class="amount">${money(b.amount)}</span>
            <button class="btn ghost icon small" onClick=${() => clearBalance(b)} aria-label=${t('common.delete')}><${Icon} name="close" size=${16} /></button>
          </div>`)}</div>` : html`<span class="small muted">${t('settings.noBalances')}</span>`}
      </div>`}
    </div>
  </${Sheet}>`;
}

function Accounts() {
  const { household } = useStore();
  const [editing, setEditing] = useState(null);
  return html`<${Section} title=${t('settings.accounts')} icon="wallet">
    <p class="small secondary" style="margin:0;padding:0 16px 8px">${t('settings.accountsHint')}</p>
    <div class="list">${household.accounts.map((a) => html`<div class="list-row tap" key=${a.id} onClick=${() => setEditing({ account: a })}>
      <${Dot} color=${seriesColor(a.color)} size=${12} />
      <div class="main-col"><div class="name">${a.name}</div>
        <div class="meta">${a.kind === 'main' ? t('settings.mainAccount') : t('settings.savingsAccount')}${a.archived ? ' · ' + t('settings.archived') : ''}</div></div>
      <${Icon} name="right" size=${18} />
    </div>`)}</div>
    <button class="add-row" onClick=${() => setEditing({})}><${Icon} name="plus" size=${18} />${t('settings.addAccount')}</button>
    ${editing && html`<${AccountSheet} account=${editing.account} onClose=${() => setEditing(null)} />`}
  </${Section}>`;
}

function Data() {
  const { year } = useStore();
  const [importing, setImporting] = useState(false);
  const restore = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !confirm(t('settings.confirmRestore'))) return;
    run(async () => {
      await request('POST', '/api/restore', await file.text());
      toast(t('settings.restored'));
    }, bump);
  };
  return html`<${Section} title=${t('settings.data')} icon="download">
    <div class="list">
      <button class="add-row" onClick=${() => setImporting(true)}><${Icon} name="upload" size=${18} />
        <span class="spacer">${t('settings.importSheet')}<div class="small muted" style="font-weight:400">${t('settings.importSheetHint')}</div></span></button>
      <a class="add-row" href=${`/api/export/${year}.csv`} download style="text-decoration:none"><${Icon} name="table" size=${18} />
        <span class="spacer">${t('settings.exportCsv', { year })}</span></a>
      <a class="add-row" href="/api/export" download style="text-decoration:none"><${Icon} name="download" size=${18} />
        <span class="spacer">${t('settings.backup')}<div class="small muted" style="font-weight:400">${t('settings.backupHint')}</div></span></a>
      <label class="add-row" style="cursor:pointer"><${Icon} name="upload" size=${18} />
        <span class="spacer">${t('settings.restore')}<div class="small muted" style="font-weight:400">${t('settings.restoreHint')}</div></span>
        <input type="file" accept=".json,application/json" class="sr-only" onChange=${restore} /></label>
    </div>
    ${importing && html`<${ImportSheet} onClose=${() => setImporting(false)} />`}
  </${Section}>`;
}

export function Settings() {
  const { household } = useStore();
  const session = useData('/api/session');
  const logout = async () => {
    await api.post('/api/logout');
    location.reload();
  };
  return html`<div style="max-width:760px">
    <${HouseholdForm} key=${JSON.stringify(household.settings)} />
    <${People} />
    <${Accounts} />
    <${Categories} />
    <${Data} />
    <section class="card" style="margin-bottom:12px">
      <div class="row"><${Icon} name="info" /><strong class="spacer">Nestegg ${household.version}</strong>
        ${session.data?.auth_required && html`<button class="btn small" onClick=${logout}><${Icon} name="logout" size=${16} />${t('settings.logout')}</button>`}</div>
      <p class="small secondary" style="margin:8px 0 0">${t('settings.about')} <a href="https://github.com/kasperskytte/nestegg" target="_blank" rel="noopener">GitHub</a></p>
    </section>
  </div>`;
}
