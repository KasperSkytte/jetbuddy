// Bank sync: setting up Enable Banking, connecting banks, and sorting the
// transactions that come in onto budget items.
import { html, useState, useEffect } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, bump } from '../store.js';
import { t } from '../i18n.js';
import { money, amount, monthNames } from '../fmt.js';
import { Sheet, Switch, Icon, Dot, Empty, seriesColor, toast, toastError } from '../ui.js';
import { members, memberById, memberColor } from '../model.js';
import { ItemSheet } from './item-sheet.js';

const COUNTRIES = ['DK', 'SE', 'NO', 'FI', 'DE', 'NL', 'BE', 'FR', 'ES', 'IT', 'AT', 'PL', 'EE', 'LV', 'LT', 'IE', 'PT', 'GB'];

function ago(seconds) {
  if (!seconds) return t('bank.never');
  const mins = Math.round((Date.now() / 1000 - seconds) / 60);
  if (mins < 2) return t('bank.justNow');
  if (mins < 90) return t('bank.minutesAgo', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 36) return t('bank.hoursAgo', { n: hours });
  return t('bank.daysAgo', { n: Math.round(hours / 24) });
}

function daysLeft(iso) {
  return Math.floor((new Date(iso) - Date.now()) / 86400000);
}

/** "NETFLIX.COM" -> "Netflix.com": bank texts are often shouting. */
function tidyName(s) {
  s = (s || '').trim();
  return s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

function shortDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()}. ${monthNames('short')[d.getMonth()]}`;
}

// ------------------------------------------------------------------ setup

function SetupForm({ status, onDone }) {
  const [appId, setAppId] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.redirect_url);
      toast(t('bank.copied'));
    } catch {
      toast(status.redirect_url);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/bank/config', { app_id: appId.trim(), private_key: key });
      toast(t('common.saved'));
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="stack" style="padding:0 16px 16px">
    <p class="small secondary" style="margin:0">${t('bank.intro')}</p>
    <ol class="steps">
      <li>${t('bank.step1')} <a href="https://enablebanking.com/sign-in/" target="_blank" rel="noopener">enablebanking.com</a></li>
      <li>${t('bank.step2')}
        <div class="copy-box"><code>${status.redirect_url}</code>
          <button class="btn small" onClick=${copy}><${Icon} name="copy" size=${15} />${t('bank.copy')}</button></div>
        <div class="small muted">${t('bank.step2b')}</div></li>
      <li>${t('bank.step3')}</li>
      <li>${t('bank.step4')}</li>
    </ol>
    <label class="field"><span>${t('bank.appId')}</span>
      <input class="input" value=${appId} onInput=${(e) => setAppId(e.target.value)} placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" autocomplete="off" spellcheck="false" /></label>
    <div class="field"><span>${t('bank.key')}</span>
      <label class="btn" style="align-self:flex-start;cursor:pointer"><${Icon} name="upload" size=${18} />
        ${key ? t('bank.keyChosen') : t('bank.chooseKey')}
        <input type="file" accept=".pem,.key,application/x-pem-file,text/plain" class="sr-only"
          onChange=${async (e) => { const f = e.target.files[0]; if (f) setKey(await f.text()); }} /></label>
      <span class="hint">${t('bank.keyHint')}</span></div>
    <button class="btn primary" style="align-self:flex-start" disabled=${busy || !appId.trim() || !key} onClick=${save}>${t('common.save')}</button>
  </div>`;
}

// ------------------------------------------------------------------ choosing a bank

function BankPicker({ onClose, preset }) {
  const { household } = useStore();
  const region = (household.settings.locale || '').split('-')[1];
  const [country, setCountry] = useState(preset?.country || (COUNTRIES.includes(region) ? region : 'DK'));
  const [query, setQuery] = useState('');
  const banks = useData(`/api/bank/aspsps?country=${country}`);
  const [busy, setBusy] = useState(null);
  const connect = async (bank) => {
    setBusy(bank.name);
    try {
      const r = await api.post('/api/bank/connect', { name: bank.name, country });
      // Off to the bank's own login (MitID etc.); it sends us back to /api/bank/callback.
      location.href = r.url;
    } catch (e) {
      toastError(e);
      setBusy(null);
    }
  };
  useEffect(() => {
    if (preset) connect(preset);
  }, []);
  const list = (banks.stale ? [] : banks.data || []).filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()));
  return html`<${Sheet} title=${t('bank.chooseBank')} onClose=${onClose}>
    <div class="stack">
      <div class="row">
        <select class="input" style="width:96px" value=${country} onChange=${(e) => setCountry(e.target.value)} aria-label=${t('bank.country')}>
          ${COUNTRIES.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}</select>
        <input class="input" value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder=${t('bank.search')} />
      </div>
      ${banks.error && html`<p class="bad small" style="margin:0">${banks.error.message}</p>`}
      ${banks.loading && !list.length && !banks.error && html`<p class="muted">${t('common.loading')}</p>`}
      <div class="list" style="margin:0 -18px">${list.map((b) => html`<button key=${b.name} class="add-row" style="color:var(--text);min-height:56px" disabled=${!!busy} onClick=${() => connect(b)}>
        ${b.logo ? html`<img src=${b.logo} alt="" width="28" height="28" style="object-fit:contain;border-radius:6px;background:#fff" />` : html`<${Icon} name="bank" />`}
        <span class="spacer">${b.name}${b.beta && html` <span class="badge">beta</span>`}</span>
        ${busy === b.name ? html`<span class="small muted">${t('bank.opening')}</span>` : html`<${Icon} name="right" size=${18} />`}
      </button>`)}</div>
      <p class="small muted" style="margin:0">${t('bank.pickerHint')}</p>
    </div>
  </${Sheet}>`;
}

// ------------------------------------------------------------------ settings section

export function BankSettings() {
  const { household } = useStore();
  const status = useData('/api/bank/status');
  const [picker, setPicker] = useState(null); // {} or { preset }
  const [syncing, setSyncing] = useState(false);
  const s = status.data;

  // Coming back from the bank: /#/settings?bank=connected
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    if (!q.get('bank')) return;
    if (q.get('bank') === 'connected') toast(t('bank.connected', { n: q.get('new') || 0 }));
    else toast(t('bank.connectFailed', { message: q.get('message') || '' }), { error: true });
    history.replaceState(null, '', '#/settings');
    bump();
  }, []);

  if (!s) return null;
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.post('/api/bank/sync');
      if (r.errors.length) toast(r.errors.join('\n'), { error: true });
      else toast(t('bank.synced', { n: r.new }));
      bump();
    } catch (e) {
      toastError(e);
    } finally {
      setSyncing(false);
    }
  };
  const disconnect = async (session) => {
    if (!confirm(t('bank.confirmDisconnect', { name: session.aspsp_name }))) return;
    try {
      await api.del(`/api/bank/sessions/${session.id}`);
      bump();
    } catch (e) {
      toastError(e);
    }
  };
  const updateAccount = async (id, patch) => {
    try {
      await api.patch(`/api/bank/accounts/${id}`, patch);
      bump();
    } catch (e) {
      toastError(e);
    }
  };
  const removeConfig = async () => {
    if (!confirm(t('bank.confirmRemoveKey'))) return;
    await api.del('/api/bank/config');
    bump();
  };
  const removeRule = async (id) => {
    await api.del(`/api/bank/rules/${id}`);
    bump();
  };

  return html`<section class="card flush" style="margin-bottom:12px">
    <div class="member-head"><${Icon} name="bank" /><h2>${t('bank.title')}</h2>
      ${s.sessions.length > 0 && html`<button class="btn small" disabled=${syncing} onClick=${sync}><${Icon} name="sync" size=${16} />${syncing ? t('bank.syncing') : t('bank.syncNow')}</button>`}</div>
    ${!s.configured ? html`<${SetupForm} status=${s} onDone=${bump} />` : html`
      ${s.sessions.length === 0 && html`<div style="padding:0 16px 16px" class="stack">
        <p class="small secondary" style="margin:0">${t('bank.ready')}</p>
        <button class="btn primary" style="align-self:flex-start" onClick=${() => setPicker({})}><${Icon} name="link" size=${18} />${t('bank.connect')}</button>
      </div>`}
      ${s.sessions.map((session) => {
        const left = daysLeft(session.valid_until);
        const expired = session.status !== 'active' || left < 0;
        const accounts = s.accounts.filter((a) => a.session_id === session.id);
        return html`<div key=${session.id} style="border-top:1px solid var(--border)">
          <div class="list-row" style="border:0">
            <${Icon} name="bank" />
            <div class="main-col"><div class="name">${session.aspsp_name}</div>
              <div class="small muted">
                ${expired ? html`<span class="bad">${t('bank.expired')}</span>`
                  : html`<span class=${left < 14 ? 'bad' : ''}>${t('bank.validFor', { n: left })}</span>`}
                · ${t('bank.lastSync', { when: ago(session.last_sync) })}</div>
              ${session.last_error && html`<div class="small bad">${session.last_error}</div>`}</div>
          </div>
          <div class="row wrap" style="padding:0 16px 10px">
            ${(expired || left < 14) && html`<button class="btn small primary" onClick=${() => setPicker({ preset: { name: session.aspsp_name, country: session.aspsp_country } })}>${t('bank.renew')}</button>`}
            <button class="btn small ghost danger" onClick=${() => disconnect(session)}>${t('bank.disconnect')}</button>
          </div>
          ${accounts.map((a) => html`<div key=${a.id} class="bank-account">
            <div class="row"><strong class="spacer ellipsis">${a.name}</strong><span class="num" style="font-weight:650">${a.balance != null ? money(a.balance) : '–'}</span></div>
            ${a.iban && html`<div class="small muted">${a.iban}</div>`}
            <label class="field" style="margin-top:8px"><span>${t('bank.followsAccount')}</span>
              <select class="input" value=${a.account_id ?? ''} onChange=${(e) => updateAccount(a.id, { account_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">${t('bank.noAccount')}</option>
                ${household.accounts.filter((x) => !x.archived).map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}
              </select></label>
            <${Switch} checked=${a.track} onChange=${(track) => updateAccount(a.id, { track })} label=${t('bank.track')} hint=${t('bank.trackHint')} />
          </div>`)}
        </div>`;
      })}
      ${s.sessions.length > 0 && html`<button class="add-row" onClick=${() => setPicker({})}><${Icon} name="plus" size=${18} />${t('bank.connectAnother')}</button>`}
      ${s.rules.length > 0 && html`<div>
        <div class="group-label">${t('bank.rules')}</div>
        <div class="list">${s.rules.map((r) => html`<div class="list-row" key=${r.id} style="min-height:48px">
          <div class="main-col"><div class="name" style="font-weight:500">“${r.pattern}”</div>
            <div class="meta">→ ${r.ignore ? t('bank.ignored') : r.item_name}</div></div>
          <button class="btn ghost icon small" onClick=${() => removeRule(r.id)} aria-label=${t('common.delete')}><${Icon} name="trash" size=${17} /></button>
        </div>`)}</div>
      </div>`}
      <p class="small muted" style="margin:0;padding:10px 16px 14px">${t('bank.autoSync', { n: s.sync_hours })}
        ${!s.from_env && html` <button class="btn ghost small danger" onClick=${removeConfig}>${t('bank.removeKey')}</button>`}</p>
    `}
    ${picker && html`<${BankPicker} preset=${picker.preset} onClose=${() => setPicker(null)} />`}
  </section>`;
}

// ------------------------------------------------------------------ sorting transactions

function AssignView({ tx, items, year, onBack, onDone }) {
  const { household } = useStore();
  const kind = tx.amount > 0 ? 'income' : 'expense';
  const [query, setQuery] = useState('');
  const [rule, setRule] = useState(true);
  const [pattern, setPattern] = useState(tx.pattern);
  const [creating, setCreating] = useState(false);
  const matching = items.filter((i) => i.kind === kind);
  const shown = matching.filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase()));
  const suggestions = tx.suggestions.map((id) => items.find((i) => i.id === id)).filter(Boolean);

  const assign = async (body) => {
    try {
      const r = await api.put(`/api/bank/transactions/${tx.id}`, { ...body, rule: rule && pattern.trim() ? pattern.trim() : null });
      toast(r.sorted > 1 ? t('bank.sortedMore', { n: r.sorted - 1 }) : t('bank.sorted'));
      onDone();
    } catch (e) {
      toastError(e);
    }
  };

  const shared = members(household).find((m) => m.is_shared);
  const ItemButton = ({ item }) => html`<button class="add-row" style="color:var(--text);font-weight:500" onClick=${() => assign({ item_id: item.id })}>
    <${Dot} color=${memberColor(household, item.member_id)} />
    <span class="spacer ellipsis">${item.name}<span class="small muted"> · ${memberById(household, item.member_id)?.name}</span></span>
    ${tx.item_id === item.id && html`<${Icon} name="check" size=${18} />`}
  </button>`;

  return html`<div class="stack">
    <button class="btn ghost small" style="align-self:flex-start;margin-left:-8px" onClick=${onBack}><${Icon} name="left" size=${16} />${t('common.back')}</button>
    <div class="tx-head">
      <div class="small muted">${shortDate(tx.booking_date)} · ${tx.account_name}</div>
      <div class="row"><strong class="spacer">${tx.counterparty || tx.text}</strong>
        <span class=${'num ' + (tx.amount > 0 ? 'good' : '')} style="font-weight:700;font-size:18px">${tx.amount > 0 ? '+' : ''}${amount(tx.amount)}</span></div>
      ${tx.counterparty && tx.text && html`<div class="small secondary">${tx.text}</div>`}
    </div>
    <div class="rule-box">
      <label class="switch" style="min-height:36px">
        <span class="text small">${t('bank.remember')}</span>
        <input type="checkbox" role="switch" checked=${rule} onChange=${(e) => setRule(e.target.checked)} />
      </label>
      ${rule && html`<input class="input" value=${pattern} onInput=${(e) => setPattern(e.target.value)} aria-label=${t('bank.remember')} />`}
    </div>
    ${suggestions.length > 0 && html`<div>
      <div class="group-label" style="padding-left:0">${t('bank.suggestions')}</div>
      <div class="list" style="margin:0 -18px">${suggestions.map((item) => html`<${ItemButton} key=${item.id} item=${item} />`)}</div>
    </div>`}
    <div>
      <div class="group-label" style="padding-left:0">${kind === 'income' ? t('bank.incomeItems') : t('bank.expenseItems')}</div>
      ${matching.length > 8 && html`<input class="input" value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder=${t('bank.search')} style="margin-bottom:6px" />`}
      <div class="list" style="margin:0 -18px">${shown.map((item) => html`<${ItemButton} key=${item.id} item=${item} />`)}</div>
    </div>
    <div class="row wrap">
      <button class="btn" onClick=${() => setCreating(true)}><${Icon} name="plus" size=${16} />${t('bank.newItem')}</button>
      <button class="btn" onClick=${() => assign({ ignored: true })}>${t('bank.ignore')}</button>
      ${(tx.item_id || tx.ignored) && html`<button class="btn ghost" onClick=${() => assign({ item_id: null, ignored: false })}>${t('bank.unsort')}</button>`}
    </div>
    <p class="small muted" style="margin:0">${t('bank.ignoreHint')}</p>
    ${creating && html`<${ItemSheet} year=${year} member=${shared} kind=${kind}
      initial=${{ name: tidyName(tx.counterparty || tx.text), month: tx.month, amount: Math.abs(tx.amount) }}
      onClose=${() => setCreating(false)} onChanged=${() => {}} onCreated=${(item) => assign({ item_id: item.id })} />`}
  </div>`;
}

function TxRow({ tx, items, onOpen }) {
  const { household } = useStore();
  const item = tx.item_id && items.find((i) => i.id === tx.item_id);
  return html`<button class="add-row tx-row" onClick=${() => onOpen(tx)}>
    <div class="spacer" style="min-width:0">
      <div class="ellipsis" style="color:var(--text);font-weight:560">${tx.counterparty || tx.text || '–'}</div>
      <div class="small muted ellipsis" style="font-weight:400">${shortDate(tx.booking_date)}
        ${item ? html` · <span style="color:var(--text-2)"><${Dot} color=${memberColor(household, item.member_id)} size=${7} /> ${item.name}</span>`
          : tx.ignored ? ' · ' + t('bank.ignored') : tx.counterparty && tx.text ? ' · ' + tx.text : ''}</div>
    </div>
    <span class=${'num ' + (tx.amount > 0 ? 'good' : '')} style=${{ fontWeight: 650, color: tx.amount > 0 ? null : 'var(--text)' }}>${tx.amount > 0 ? '+' : ''}${amount(tx.amount)}</span>
  </button>`;
}

/** The month's bank transactions; unsorted first. */
export function TransactionsSheet({ year, month, items, onClose, onChanged }) {
  const txs = useData(`/api/bank/transactions?year=${year}&month=${month}`);
  const [open, setOpen] = useState(null);
  const [showSorted, setShowSorted] = useState(false);
  const long = monthNames('long');
  const list = txs.data || [];
  const unsorted = list.filter((x) => !x.item_id && !x.ignored);
  const sorted = list.filter((x) => x.item_id || x.ignored);
  const done = () => {
    setOpen(null);
    txs.reload();
    onChanged();
  };
  return html`<${Sheet} title=${t('bank.monthTitle', { month: long[month - 1] })} onClose=${onClose}>
    ${open ? html`<${AssignView} tx=${open} items=${items} year=${year} onBack=${() => setOpen(null)} onDone=${done} />` : html`
      ${!txs.data ? html`<p class="muted">${t('common.loading')}</p>` : list.length === 0 ? html`<${Empty} title=${t('bank.noTransactions')} />` : html`
        <div class="group-label" style="padding-left:0">${t('bank.unsorted', { n: unsorted.length })}</div>
        ${unsorted.length === 0 && html`<p class="small secondary" style="margin:0 0 8px">${t('bank.allSorted')}</p>`}
        <div class="list" style="margin:0 -18px">${unsorted.map((x) => html`<${TxRow} key=${x.id} tx=${x} items=${items} onOpen=${setOpen} />`)}</div>
        ${sorted.length > 0 && html`<button class="add-row" style="margin:8px -18px 0;width:calc(100% + 36px);color:var(--text-2)" onClick=${() => setShowSorted(!showSorted)}>
          <${Icon} name=${showSorted ? 'up' : 'down'} size=${18} />${t('bank.sortedCount', { n: sorted.length })}</button>`}
        ${showSorted && html`<div class="list" style="margin:0 -18px">${sorted.map((x) => html`<${TxRow} key=${x.id} tx=${x} items=${items} onOpen=${setOpen} />`)}</div>`}
      `}`}
  </${Sheet}>`;
}
