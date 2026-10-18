import { html, useState } from '../lib.js';
import { api, request } from '../api.js';
import { useStore, setStore, reloadHousehold, applyTheme, bump, useData, applySettings } from '../store.js';
import { t, LANGUAGES } from '../i18n.js';
import { money, monthNames, defaultDecimal } from '../fmt.js';
import { Sheet, Swatches, Switch, Segmented, Dot, Icon, seriesColor, toast, toastError, errorText } from '../ui.js';
import { categories } from '../model.js';
import { ImportSheet } from './import.js';
import { BankSettings } from './bank.js';
import { ExportSheet } from './export.js';
import { InstallGuide } from './install.js';
import { ChecksSheet } from './checks.js';

export const CURRENCIES = ['DKK', 'EUR', 'USD', 'GBP', 'SEK', 'NOK', 'ISK', 'CHF', 'PLN', 'CZK', 'CAD', 'AUD', 'NZD', 'JPY', 'INR', 'BRL', 'ZAR'];

/** Comma, dot, or either as the decimal separator, with an example of each. */
export function DecimalChoice({ value, onChange, both = 'last', onBothChange }) {
  const hint = value === ',' ? t('settings.commaHint') : value === '.' ? t('settings.dotHint') : t('settings.eitherHint');
  return html`<${Segmented} value=${value} onChange=${onChange} label=${t('settings.decimal')}
    options=${[
      { value: ',', label: `${t('settings.comma')}  1.234,56` },
      { value: '.', label: `${t('settings.dot')}  1,234.56` },
      { value: 'either', label: `${t('settings.either')}  1,5/1.5` },
    ]} />
    <span class="hint">${hint}</span>
    ${value === 'either' && onBothChange && html`<div class="field" style="margin-top:8px"><span>${t('settings.bothTitle')}</span>
      <${Segmented} value=${both} onChange=${onBothChange} label=${t('settings.bothTitle')}
        options=${[{ value: 'last', label: t('settings.bothLast') }, { value: 'invalid', label: t('settings.bothInvalid') }]} />
      <span class="hint">${both === 'invalid' ? t('settings.bothInvalidHint') : t('settings.bothLastHint')}</span></div>`}
    <span class="hint">${t('settings.invalidHint')}</span>`;
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

function PasswordSheet({ onClose }) {
  const [form, setForm] = useState({ current: '', password: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  const short = form.password.length < 8;
  const mismatch = form.repeat !== form.password;
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/login-details', { current_password: form.current, password: form.password });
      toast(t('settings.loginChanged'));
      onClose();
    } catch (e) {
      toast(e.status === 401 ? t('settings.wrongPassword') : errorText(e), { error: true });
    } finally {
      setBusy(false);
    }
  };
  return html`<${Sheet} title=${t('settings.changeLogin')} onClose=${onClose}
    footer=${html`<span class="spacer"></span><button class="btn" onClick=${onClose}>${t('common.cancel')}</button>
      <button class="btn primary" disabled=${busy || !form.current || short || mismatch} onClick=${save}>${t('common.save')}</button>`}>
    <div class="form-grid">
      <label class="field"><span>${t('settings.newPassword')}</span>
        <input class="input" type="password" autocomplete="new-password" value=${form.password} onInput=${(e) => set({ password: e.target.value })} autofocus />
        ${form.password && short && html`<span class="hint bad">${t('setup.passwordShort')}</span>`}</label>
      <label class="field"><span>${t('setup.passwordRepeat')}</span>
        <input class="input" type="password" autocomplete="new-password" value=${form.repeat} onInput=${(e) => set({ repeat: e.target.value })} />
        ${form.repeat && mismatch && html`<span class="hint bad">${t('setup.passwordMismatch')}</span>`}</label>
      <label class="field"><span>${t('settings.currentPassword')}</span>
        <input class="input" type="password" autocomplete="current-password" value=${form.current} onInput=${(e) => set({ current: e.target.value })} />
        <span class="hint">${t('settings.currentPasswordHint')}</span></label>
    </div>
  </${Sheet}>`;
}

function DeleteBudgetSheet({ name, onClose }) {
  const [password, setPassword] = useState('');
  const remove = async () => {
    if (!confirm(t('settings.deleteBudgetConfirm', { name }))) return;
    try {
      await api.post('/api/budget/delete', { password });
      location.reload();
    } catch (e) {
      toast(e.status === 401 ? t('settings.wrongPassword') : errorText(e), { error: true });
    }
  };
  return html`<${Sheet} title=${t('settings.deleteBudget')} onClose=${onClose}
    footer=${html`<span class="spacer"></span><button class="btn" onClick=${onClose}>${t('common.cancel')}</button>
      <button class="btn primary" style="background:var(--bad);border-color:var(--bad)" disabled=${!password} onClick=${remove}>${t('settings.deleteBudget')}</button>`}>
    <div class="stack">
      <p class="secondary" style="margin:0">${t('settings.deleteBudgetText', { name })}</p>
      <label class="field"><span>${t('login.password')}</span>
        <input class="input" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} /></label>
    </div>
  </${Sheet}>`;
}

function LoginSection() {
  const { session, household } = useStore();
  const [sheet, setSheet] = useState(null);
  const login = session?.budget?.login || '';
  const logout = async () => {
    await api.post('/api/logout');
    location.reload();
  };
  return html`<${Section} title=${t('settings.login')} icon="lock">
    <div class="list-row" style="border-top:0">
      <div class="main-col"><div class="name">${household.settings.household}</div><div class="meta" style="white-space:normal">${t('settings.loginHint')}</div></div>
    </div>
    <button class="add-row" onClick=${() => setSheet('change')}><${Icon} name="edit" size=${18} />${t('settings.changeLogin')}</button>
    <button class="add-row" onClick=${logout}><${Icon} name="logout" size=${18} />${t('settings.logout')}</button>
    <button class="add-row" style="color:var(--bad)" onClick=${() => setSheet('delete')}><${Icon} name="trash" size=${18} />${t('settings.deleteBudget')}</button>
    ${sheet === 'change' && html`<${PasswordSheet} onClose=${() => setSheet(null)} />`}
    ${sheet === 'delete' && html`<${DeleteBudgetSheet} name=${household.settings.household} onClose=${() => setSheet(null)} />`}
  </${Section}>`;
}

function HouseholdForm() {
  const { household, theme } = useStore();
  const s = household.settings;
  const [form, setForm] = useState(() => ({
    household: s.household || '',
    language: s.language || 'en',
    decimal: s.decimal || defaultDecimal(s.language || 'en'),
    decimal_both: s.decimal_both || 'last',
    currency: s.currency || 'USD',
  }));
  // Every change is saved right away; the name when leaving the field.
  const save = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    run(async () => {
      const settings = await api.put('/api/settings', patch);
      applySettings(settings);
      if (patch.household) setStore({ session: await api.get('/api/session') });
    }, () => toast(t('common.saved')));
  };
  const saveName = () => {
    const name = form.household.trim();
    if (name.length >= 2 && name !== (s.household || '')) save({ household: name });
    else setForm((f) => ({ ...f, household: s.household || '' }));
  };
  return html`<${Section} title=${t('settings.household')} icon="home">
    <div class="form-grid two" style="padding:6px 16px 16px">
      <label class="field"><span>${t('settings.householdName')}</span>
        <input class="input" value=${form.household} maxlength="100" onInput=${(e) => setForm((f) => ({ ...f, household: e.target.value }))}
          onBlur=${saveName} onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} />
        <span class="hint">${t('settings.budgetNameHint')}</span></label>
      <label class="field"><span>${t('settings.language')}</span>
        <select class="input" value=${form.language} onChange=${(e) => save({ language: e.target.value })}>
          ${Object.entries(LANGUAGES).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}</select></label>
      <label class="field"><span>${t('settings.currency')}</span>
        <select class="input" value=${form.currency} onChange=${(e) => save({ currency: e.target.value })}>
          ${(CURRENCIES.includes(form.currency) ? CURRENCIES : [form.currency, ...CURRENCIES]).map((c) => html`<option key=${c} value=${c}>${c}</option>`)}</select></label>
      <div class="field"><span>${t('settings.decimal')}</span><${DecimalChoice} value=${form.decimal} onChange=${(decimal) => save({ decimal })}
        both=${form.decimal_both} onBothChange=${(decimal_both) => save({ decimal_both })} /></div>
      <div class="field"><span>${t('settings.theme')}</span>
        <${Segmented} value=${theme} onChange=${(v) => { setStore({ theme: v }); applyTheme(v); }}
          options=${[{ value: 'auto', label: t('settings.themeAuto') }, { value: 'light', label: t('settings.themeLight') }, { value: 'dark', label: t('settings.themeDark') }]} /></div>
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

function AccountSheet({ account, bankAccount, onClose }) {
  const isNew = !account;
  const { household } = useStore();
  const hasMain = household.accounts.some((a) => a.kind === 'main' && a.id !== account?.id);
  const [form, setForm] = useState({ name: account?.name || '', kind: account?.kind || (hasMain ? 'savings' : 'main'), color: account?.color ?? household.accounts.length % 8, archived: account?.archived || false });
  const [track, setTrack] = useState(bankAccount?.track ?? true);
  const balances = useData(account ? `/api/accounts/${account.id}/balances` : null);
  const long = monthNames('long');
  const set = (p) => setForm((f) => ({ ...f, ...p }));
  const save = () => run(async () => {
    if (isNew) await api.post('/api/accounts', form);
    else await api.patch(`/api/accounts/${account.id}`, form);
    if (bankAccount && track !== bankAccount.track) await api.patch(`/api/bank/accounts/${bankAccount.id}`, { track });
  }, () => { bump(); onClose(); });
  const remove = () => {
    if (confirm(t('settings.confirmDeleteAccount', { name: account.name }))) run(() => api.del(`/api/accounts/${account.id}`), () => { bump(); onClose(); });
  };
  const clearBalance = (b) => run(() => api.put(`/api/accounts/${account.id}/balance`, { year: b.year, month: b.month, amount: null }), () => { balances.reload(); bump(); });
  // Typed-in balances only: the bank's own are shown as the account's history elsewhere.
  const typed = (balances.data || []).filter((b) => b.source !== 'bank');
  return html`<${Sheet} title=${isNew ? t('settings.addAccount') : account.name} onClose=${onClose}
    footer=${html`${!isNew && !bankAccount && html`<button class="btn ghost danger" onClick=${remove}>${t('common.delete')}</button>`}
      <span class="spacer"></span><button class="btn" onClick=${onClose}>${t('common.cancel')}</button>
      <button class="btn primary" disabled=${!form.name.trim()} onClick=${save}>${t('common.save')}</button>`}>
    <div class="form-grid">
      ${bankAccount && html`<div class="notice" style="background:var(--surface-2);margin:0">
        <div class="row"><${Icon} name="bank" size=${18} /><strong class="spacer">${bankAccount.bank || t('bank.title')}</strong>
          <span class="num" style="font-weight:650">${bankAccount.balance != null ? money(bankAccount.balance) : ''}</span></div>
        <div class="small secondary">${bankAccount.name}${bankAccount.iban ? ' · ' + bankAccount.iban : ''}</div>
        <div class="small muted" style="margin-top:4px">${t('settings.bankAccountHint')}</div></div>`}
      <label class="field"><span>${t('settings.name')}</span><input class="input" value=${form.name} onInput=${(e) => set({ name: e.target.value })} autofocus=${isNew} maxlength="60" />
        ${bankAccount && html`<span class="hint">${t('settings.bankNameHint', { name: bankAccount.name })}</span>`}</label>
      <div class="field"><span>${t('settings.accountType')}</span>
        <${Segmented} value=${form.kind} onChange=${(kind) => set({ kind })}
          options=${[{ value: 'main', label: t('settings.mainAccount') }, { value: 'savings', label: t('settings.savingsAccount') }]} />
        <span class="hint">${form.kind === 'main' ? t('settings.mainHint') : t('settings.savingsHint')}</span>
        ${form.kind === 'main' && hasMain && html`<span class="hint bad">${t('settings.oneMain')}</span>`}</div>
      ${bankAccount && html`<${Switch} checked=${track} onChange=${setTrack} label=${t('bank.track')} hint=${t('bank.trackHint')} />`}
      <div class="field"><span>${t('common.color')}</span><${Swatches} value=${form.color} onChange=${(color) => set({ color })} /></div>
      ${!isNew && html`<${Switch} checked=${form.archived} onChange=${(archived) => set({ archived })} label=${t('settings.archived')} hint=${t('settings.accountArchivedHint')} />`}
      ${!isNew && !bankAccount && html`<div class="field"><span>${t('settings.actualBalances')}</span>
        <span class="hint">${t('settings.actualBalancesHint')}</span>
        ${typed.length ? html`<div class="list" style="border:1px solid var(--border);border-radius:12px">
          ${typed.map((b) => html`<div class="list-row" key=${b.year + '-' + b.month} style="min-height:44px">
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
  const bank = useData('/api/bank/status');
  const [editing, setEditing] = useState(null);
  const bankOf = (id) => (bank.data?.accounts || []).find((b) => b.account_id === id);
  return html`<${Section} title=${t('settings.accounts')} icon="wallet">
    <p class="small secondary" style="margin:0;padding:0 16px 8px">${t('settings.accountsHint')}</p>
    <div class="list">${household.accounts.map((a) => {
      const b = bankOf(a.id);
      const kind = a.kind === 'main' ? t('settings.mainAccount') : t('settings.savingsAccount');
      return html`<div class="list-row tap" key=${a.id} onClick=${() => setEditing({ account: a, bankAccount: b })}>
        <${Dot} color=${seriesColor(a.color)} size=${12} />
        <div class="main-col"><div class="name">${a.name}</div>
          <div class="meta">${b ? html`<${Icon} name="bank" size=${12} /> ${b.bank || ''}${b.name !== a.name ? ' · ' + b.name : ''}` : t('settings.manualAccount')} · ${kind}${a.archived ? ' · ' + t('settings.archived') : ''}</div></div>
        ${b?.balance != null && html`<span class="num small" style="font-weight:650">${money(b.balance)}</span>`}
        <${Icon} name="right" size=${18} />
      </div>`;
    })}</div>
    <button class="add-row" onClick=${() => setEditing({})}><${Icon} name="plus" size=${18} />${t('settings.addManualAccount')}</button>
    ${editing && html`<${AccountSheet} account=${editing.account} bankAccount=${editing.bankAccount} onClose=${() => { setEditing(null); bank.reload(); }} />`}
  </${Section}>`;
}

function Data() {
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [checking, setChecking] = useState(false);
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
      <button class="add-row" onClick=${() => setChecking(true)}><${Icon} name="check" size=${18} />
        <span class="spacer">${t('checks.title')}<div class="small muted" style="font-weight:400">${t('checks.short')}</div></span></button>
      <button class="add-row" onClick=${() => setImporting(true)}><${Icon} name="upload" size=${18} />
        <span class="spacer">${t('settings.importSheet')}<div class="small muted" style="font-weight:400">${t('settings.importSheetHint')}</div></span></button>
      <button class="add-row" onClick=${() => setExporting(true)}><${Icon} name="table" size=${18} />
        <span class="spacer">${t('export.title')}<div class="small muted" style="font-weight:400">${t('export.short')}</div></span></button>
      <a class="add-row" href="/api/export" download style="text-decoration:none"><${Icon} name="download" size=${18} />
        <span class="spacer">${t('settings.backup')}<div class="small muted" style="font-weight:400">${t('settings.backupHint')}</div></span></a>
      <label class="add-row" style="cursor:pointer"><${Icon} name="upload" size=${18} />
        <span class="spacer">${t('settings.restore')}<div class="small muted" style="font-weight:400">${t('settings.restoreHint')}</div></span>
        <input type="file" accept=".json,application/json" class="sr-only" onChange=${restore} /></label>
    </div>
    ${importing && html`<${ImportSheet} onClose=${() => setImporting(false)} />`}
    ${exporting && html`<${ExportSheet} onClose=${() => setExporting(false)} />`}
    ${checking && html`<${ChecksSheet} onClose=${() => setChecking(false)} />`}
  </${Section}>`;
}

export function Settings() {
  const { household } = useStore();
  return html`<div style="max-width:760px">
    <${HouseholdForm} />
    <${Section} title=${t('install.title')} icon="addSquare"><div style="padding:0 16px 16px"><${InstallGuide} /></div></${Section}>
    <${People} />
    <${Accounts} />
    <${BankSettings} />
    <${Categories} />
    <${Data} />
    <${LoginSection} />
    <section class="card" style="margin-bottom:12px">
      <div class="row"><${Icon} name="info" /><strong class="spacer">Jetbuddy ${household.version}</strong></div>
      <p class="small secondary" style="margin:8px 0 0">${t('settings.about')} <a href="https://github.com/kasperskytte/jetbuddy" target="_blank" rel="noopener">GitHub</a></p>
    </section>
  </div>`;
}
