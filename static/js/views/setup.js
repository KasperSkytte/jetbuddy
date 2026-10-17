import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { setStore } from '../store.js';
import { t, LANGUAGES, setLanguage, currentLanguage } from '../i18n.js';
import { setLocale } from '../fmt.js';
import { Logo, Icon, Switch, toastError } from '../ui.js';
import { LOCALES, CURRENCIES, localeExample } from './settings.js';

function guessLocale() {
  const nav = navigator.language || 'en-US';
  return LOCALES.find((l) => l === nav) || LOCALES.find((l) => l.startsWith(nav.slice(0, 2))) || 'en-US';
}

const CURRENCY_BY_REGION = { DK: 'DKK', SE: 'SEK', NO: 'NOK', IS: 'ISK', GB: 'GBP', US: 'USD', CH: 'CHF', PL: 'PLN', CZ: 'CZK', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', IN: 'INR', BR: 'BRL', ZA: 'ZAR' };

/** First run: name the household and the people in it. */
export function Setup({ onDone }) {
  const [, rerender] = useState(0);
  const locale0 = guessLocale();
  const [form, setForm] = useState({
    household: '',
    language: currentLanguage(),
    locale: locale0,
    currency: CURRENCY_BY_REGION[locale0.split('-')[1]] || 'EUR',
    members: ['', ''],
    shared_name: t('setup.sharedDefault'),
    starter_categories: true,
    starter_accounts: true,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const names = form.members.map((m) => m.trim()).filter(Boolean);

  const changeLanguage = (language) => {
    const before = t('setup.sharedDefault');
    setLanguage(language);
    // Keep the shared name in step with the language unless it was edited.
    set({ language, shared_name: form.shared_name === before ? t('setup.sharedDefault') : form.shared_name });
    rerender((n) => n + 1);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const household = await api.post('/api/setup', { ...form, household: form.household.trim(), members: names });
      setLocale(form.locale, form.currency);
      setStore({ household });
      onDone(household);
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return html`<div class="center-page"><form class="card center-card stack" style="gap:16px" onSubmit=${submit}>
    <div class="logo-row"><${Logo} size=${44} /><div><div class="name">Nestegg</div><div class="small secondary">${t('setup.tagline')}</div></div></div>
    <label class="field"><span>${t('settings.language')}</span>
      <select class="input" value=${form.language} onChange=${(e) => changeLanguage(e.target.value)}>
        ${Object.entries(LANGUAGES).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}</select></label>
    <label class="field"><span>${t('settings.householdName')}</span>
      <input class="input" value=${form.household} onInput=${(e) => set({ household: e.target.value })} placeholder=${t('setup.householdPlaceholder')} maxlength="100" autofocus /></label>
    <div class="field"><span>${t('setup.people')}</span>
      <span class="hint">${t('setup.peopleHint')}</span>
      ${form.members.map((m, i) => html`<div class="row" key=${i}>
        <input class="input" value=${m} placeholder=${t('setup.personPlaceholder', { n: i + 1 })} maxlength="60"
          onInput=${(e) => set({ members: form.members.map((x, k) => (k === i ? e.target.value : x)) })} />
        ${form.members.length > 1 && html`<button type="button" class="btn ghost icon" aria-label=${t('common.delete')}
          onClick=${() => set({ members: form.members.filter((_, k) => k !== i) })}><${Icon} name="close" size=${18} /></button>`}
      </div>`)}
      <button type="button" class="btn small" style="align-self:flex-start" onClick=${() => set({ members: [...form.members, ''] })}>
        <${Icon} name="plus" size=${16} />${t('setup.addPerson')}</button>
    </div>
    <label class="field"><span>${t('setup.sharedName')}</span>
      <input class="input" value=${form.shared_name} onInput=${(e) => set({ shared_name: e.target.value })} maxlength="60" />
      <span class="hint">${t('setup.sharedHint')}</span></label>
    <div class="form-grid two">
      <label class="field"><span>${t('settings.currency')}</span>
        <select class="input" value=${form.currency} onChange=${(e) => set({ currency: e.target.value })}>
          ${CURRENCIES.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}</select></label>
      <label class="field"><span>${t('settings.numberFormat')}</span>
        <select class="input" value=${form.locale} onChange=${(e) => set({ locale: e.target.value })}>
          ${LOCALES.map((l) => html`<option key=${l} value=${l}>${localeExample(l)}</option>`)}</select></label>
    </div>
    <${Switch} checked=${form.starter_categories} onChange=${(v) => set({ starter_categories: v })} label=${t('setup.starterCategories')} />
    <${Switch} checked=${form.starter_accounts} onChange=${(v) => set({ starter_accounts: v })} label=${t('setup.starterAccounts')} hint=${t('setup.starterAccountsHint')} />
    <button class="btn primary block" disabled=${busy || !form.household.trim() || !names.length || !form.shared_name.trim()}>${t('setup.start')}</button>
  </form></div>`;
}
