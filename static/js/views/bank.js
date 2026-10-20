// Bank sync: setting up Enable Banking, connecting banks, and reconciling
// the budget: putting the transactions that come in onto budget items and
// seeing where the bank and the budget differ.
import { html, useState, useEffect } from '../lib.js';
import { api } from '../api.js';
import { useStore, useData, bump, reloadHousehold } from '../store.js';
import { t } from '../i18n.js';
import { amount, signed, monthNames } from '../fmt.js';
import { Sheet, Icon, Dot, toast, toastError, errorText } from '../ui.js';
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

const PROJECT_URL = 'https://github.com/kasperskytte/sparegrisen';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('bank.copied'));
  } catch {
    // Clipboard needs https; select the text instead so it can be copied by hand.
    toast(t('bank.copyFailed'), { error: true });
  }
}

function CopyValue({ value, mono = false }) {
  return html`<div class="copy-box"><code style=${mono ? '' : 'font-family:inherit'}>${value}</code>
    <button class="btn small" type="button" onClick=${() => copyText(value)}><${Icon} name="copy" size=${15} />${t('bank.copy')}</button></div>`;
}

function Step({ n, title, done, children }) {
  return html`<li class=${'step' + (done ? ' done' : '')}>
    <span class="step-n" aria-hidden="true">${done ? html`<${Icon} name="check" size=${15} stroke=${2.6} />` : n}</span>
    <div class="step-body"><strong>${title}</strong>${children}</div>
  </li>`;
}

/** Shows how a test of the Enable Banking connection went, with what to do about a failure. */
function TestResult({ result }) {
  if (!result) return null;
  if (result.ok) return html`<div class="notice good-notice"><${Icon} name="check" size=${18} /> ${t('bank.testOk')}</div>`;
  return html`<div class="notice bad-notice"><strong>${t('bank.testFailed')}</strong>
    <div class="small">${result.message}</div>
    <ul class="small" style="margin:6px 0 0;padding-left:18px">
      <li>${t('bank.testHint1')}</li><li>${t('bank.testHint2')}</li><li>${t('bank.testHint3')}</li>
    </ul></div>`;
}

function SetupGuide({ status, onDone }) {
  const [cert, setCert] = useState(status.pending_certificate);
  const [appId, setAppId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [ownKey, setOwnKey] = useState(null); // text of an uploaded private key
  const http = status.redirect_url.startsWith('http:');

  const makeCert = async () => {
    setBusy(true);
    try {
      setCert((await api.post('/api/bank/certificate')).certificate);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.put('/api/bank/config', { app_id: appId.trim(), private_key: ownKey });
      setResult(r.test);
      if (r.test.ok) setTimeout(onDone, 1200);
      else onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return html`<div class="stack" style="padding:0 16px 16px">
    <p class="small secondary" style="margin:0">${t('bank.intro')}</p>
    <ol class="steps">
      <${Step} n="1" title=${t('bank.s1Title')}>
        <div class="small secondary">${t('bank.s1Text')}</div>
        <a class="btn small" style="align-self:flex-start;margin-top:6px" href="https://enablebanking.com/sign-in/" target="_blank" rel="noopener">
          ${t('bank.s1Button')} <${Icon} name="right" size=${15} /></a>
      </${Step}>

      <${Step} n="2" title=${t('bank.s2Title')} done=${!!cert}>
        <div class="small secondary">${t('bank.s2Text')}</div>
        ${cert ? html`<textarea class="input cert" readonly rows="5" onFocus=${(e) => e.target.select()}>${cert}</textarea>
            <button class="btn small" style="align-self:flex-start" onClick=${() => copyText(cert)}><${Icon} name="copy" size=${15} />${t('bank.copyCert')}</button>`
          : html`<button class="btn small primary" style="align-self:flex-start;margin-top:6px" disabled=${busy} onClick=${makeCert}>${t('bank.s2Button')}</button>`}
      </${Step}>

      <${Step} n="3" title=${t('bank.s3Title')}>
        <div class="small secondary">${t('bank.s3Text')}</div>
        <dl class="form-fields">
          <dt>Environment</dt><dd><strong>Production</strong><div class="small muted">${t('bank.fEnv')}</div></dd>
          <dt>${t('bank.fKeyLabel')}</dt><dd><strong>Generate outside the browser and import public certificate</strong></dd>
          <dt>Application name</dt><dd><${CopyValue} value="Sparegrisen" /></dd>
          <dt>Allowed redirect URLs</dt><dd><${CopyValue} value=${status.redirect_url} mono />
            <div class="small muted">${t('bank.fRedirect')}</div>
            ${http && html`<div class="small bad">${t('bank.fRedirectHttp')}</div>`}</dd>
          <dt>${t('bank.fDescLabel')}</dt><dd><${CopyValue} value=${t('bank.fDescValue')} /></dd>
          <dt>Email for data protection matters</dt><dd>${t('bank.fEmail')}</dd>
          <dt>Privacy URL / Terms URL</dt><dd><${CopyValue} value=${PROJECT_URL} /><div class="small muted">${t('bank.fUrls')}</div></dd>
          <dt>Public certificate</dt><dd>${cert ? t('bank.fCert') : html`<span class="bad">${t('bank.fCertMissing')}</span>`}</dd>
        </dl>
        <div class="small secondary">${t('bank.s3Done')}</div>
      </${Step}>

      <${Step} n="4" title=${t('bank.s4Title')}>
        <div class="small secondary">${t('bank.s4Text')}</div>
      </${Step}>

      <${Step} n="5" title=${t('bank.s5Title')}>
        <div class="small secondary">${t('bank.s5Text')}</div>
        <input class="input" style="margin-top:6px" value=${appId} onInput=${(e) => setAppId(e.target.value)}
          placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label=${t('bank.appId')} />
        <button class="btn primary" style="align-self:flex-start;margin-top:8px" disabled=${busy || !appId.trim() || (!cert && !ownKey)} onClick=${save}>
          ${busy ? t('bank.testing') : t('bank.s5Button')}</button>
        <${TestResult} result=${result} />
      </${Step}>
    </ol>

    <details class="more">
      <summary>${t('bank.ownKey')}</summary>
      <div class="stack" style="padding-top:8px">
        <p class="small secondary" style="margin:0">${t('bank.ownKeyText')}</p>
        <label class="btn small" style="align-self:flex-start;cursor:pointer"><${Icon} name="upload" size=${16} />
          ${t('bank.chooseKey')}
          <input type="file" accept=".pem,.key,application/x-pem-file,text/plain" class="sr-only"
            onChange=${async (e) => { const f = e.target.files[0]; if (f) setOwnKey(await f.text()); }} /></label>
        <label class="field"><span>${t('bank.pasteKey')}</span>
          <textarea class="input cert" rows="5" spellcheck="false" autocomplete="off" value=${ownKey || ''}
            placeholder="-----BEGIN PRIVATE KEY-----" onInput=${(e) => setOwnKey(e.target.value.trim() ? e.target.value : null)}></textarea></label>
        ${ownKey && html`<span class="small good">${t('bank.keyChosen')}</span>`}
        <span class="small muted">${t('bank.keyHint')}</span>
      </div>
    </details>
  </div>`;
}

function ConfiguredInfo({ status }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      setResult(await api.post('/api/bank/test'));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return html`<div style="padding:0 16px 12px" class="stack">
    <div class="row wrap small secondary">
      <span class="spacer">${t('bank.configuredAs')} <code>${status.app_id}</code></span>
      <button class="btn small" disabled=${busy} onClick=${test}>${busy ? t('bank.testing') : t('bank.test')}</button>
    </div>
    <${TestResult} result=${result} />
    ${status.certificate && html`<details class="more small"><summary>${t('bank.showCert')}</summary>
      <textarea class="input cert" readonly rows="5" onFocus=${(e) => e.target.select()}>${status.certificate}</textarea></details>`}
  </div>`;
}

// ------------------------------------------------------------------ choosing a bank

function BankPicker({ onClose, preset }) {
  const { household } = useStore();
  const BY_CURRENCY = { DKK: 'DK', SEK: 'SE', NOK: 'NO', ISK: 'IS', GBP: 'GB', PLN: 'PL', CZK: 'CZ' };
  const region = BY_CURRENCY[household.settings.currency] || (household.settings.language === 'da' ? 'DK' : null);
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
    if (q.get('bank') === 'connected') {
      toast(t('bank.connected', { n: q.get('new') || 0 }));
      reloadHousehold();
    }
    else toast(t('bank.connectFailed', { message: errorText({ code: q.get('code'), message: q.get('message') || '' }) }), { error: true });
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
      await reloadHousehold(); // accounts removed at the bank are gone now
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
      await reloadHousehold();
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
    ${!s.configured ? html`<${SetupGuide} status=${s} onDone=${bump} />` : html`
      <${ConfiguredInfo} status=${s} />
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
            <button class=${'btn small' + (expired || left < 14 ? ' primary' : '')} onClick=${() => setPicker({ preset: { name: session.aspsp_name, country: session.aspsp_country } })}>${t('bank.renew')}</button>
            <button class="btn small ghost danger" onClick=${() => disconnect(session)}>${t('bank.disconnect')}</button>
          </div>
          ${accounts.length > 0 && html`<p class="small secondary" style="margin:0;padding:0 16px 12px">
            ${t('bank.sessionAccounts', { n: accounts.length, names: accounts.map((a) => household.accounts.find((x) => x.id === a.account_id)?.name || a.name).join(', ') })}</p>`}
        </div>`;
      })}
      ${s.sessions.length > 0 && html`<button class="add-row" onClick=${() => setPicker({})}><${Icon} name="plus" size=${18} />${t('bank.connectAnother')}</button>
        <details class="more small" style="padding:0 16px 8px"><summary>${t('bank.missingTitle')}</summary>
          <ul style="margin:4px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px" class="secondary">
            <li>${t('bank.missing1')}</li><li>${t('bank.missing2')}</li><li>${t('bank.missing3')}</li>
          </ul></details>`}
      ${s.rules.length > 0 && html`<div>
        <div class="group-label">${t('bank.rules')}</div>
        <div class="list">${s.rules.map((r) => html`<div class="list-row" key=${r.id} style="min-height:48px">
          <div class="main-col"><div class="name" style="font-weight:500">“${r.pattern}”${r.amount != null ? ' ' + t('bank.ruleAmountShort', { amount: amount(signed(r.amount, r.item_kind)) }) : ''}</div>
            <div class="meta">→ ${r.ignore ? t('bank.ignored') : r.item_name}</div></div>
          <button class="btn ghost icon small" onClick=${() => removeRule(r.id)} aria-label=${t('common.delete')}><${Icon} name="trash" size=${17} /></button>
        </div>`)}</div>
      </div>`}
      <p class="small muted" style="margin:0;padding:10px 16px 14px">${s.sync_hours > 0 ? t('bank.autoSync', { n: s.sync_hours }) : t('bank.autoSyncOff')}
        <button class="btn ghost small danger" onClick=${removeConfig}>${t('bank.removeKey')}</button></p>
    `}
    ${picker && html`<${BankPicker} preset=${picker.preset} onClose=${() => setPicker(null)} />`}
  </section>`;
}

// ------------------------------------------------------------------ sorting transactions

export function AssignView({ tx, items, year, onBack, onDone }) {
  const { household } = useStore();
  const kind = tx.amount > 0 ? 'income' : 'expense';
  const [query, setQuery] = useState('');
  const [rule, setRule] = useState(false);
  const [pattern, setPattern] = useState(tx.pattern);
  const [sameAmount, setSameAmount] = useState(false);
  const [creating, setCreating] = useState(false);
  const matching = items.filter((i) => i.kind === kind);
  const shown = matching.filter((i) => i.name.toLowerCase().includes(query.trim().toLowerCase()));
  const suggestions = tx.suggestions.map((id) => items.find((i) => i.id === id)).filter(Boolean);

  const assign = async (body) => {
    try {
      const r = await api.put(`/api/bank/transactions/${tx.id}`, { ...body, rule: rule && pattern.trim() ? pattern.trim() : null, rule_amount: sameAmount });
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
      ${rule && html`<label class="field" style="margin-top:4px"><span>${t('bank.ruleText')}</span>
        <input class="input" value=${pattern} onInput=${(e) => setPattern(e.target.value)} /></label>
        <label class="row" style="cursor:pointer;min-height:40px;gap:10px"><input type="checkbox" checked=${sameAmount}
          onChange=${(e) => setSameAmount(e.target.checked)} style="width:20px;height:20px" />
          <span class="small">${t('bank.ruleAmount', { amount: amount(tx.amount) })}</span></label>
        <span class="small muted">${t('bank.ruleAmountHint')}</span>`}
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
