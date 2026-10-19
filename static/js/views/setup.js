import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { setStore } from '../store.js';
import { t, LANGUAGES, setLanguage, currentLanguage } from '../i18n.js';
import { setFormat, defaultDecimal } from '../fmt.js';
import { Logo, Icon, toastError } from '../ui.js';
import { CURRENCIES, DecimalChoice } from './settings.js';

/** The decimal separator people here are used to, from the browser's language. */
function guessDecimal() {
  try {
    return new Intl.NumberFormat(navigator.language).formatToParts(1.5).find((p) => p.type === 'decimal')?.value === '.' ? '.' : ',';
  } catch {
    return ',';
  }
}

const CURRENCY_BY_REGION = { DK: 'DKK', SE: 'SEK', NO: 'NOK', IS: 'ISK', GB: 'GBP', US: 'USD', CH: 'CHF', PL: 'PLN', CZ: 'CZK', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', IN: 'INR', BR: 'BRL', ZA: 'ZAR' };

/** First run: name the household and the people in it. */
export function Setup({ onDone, onBack }) {
  const [, rerender] = useState(0);
  const region = (navigator.language || '').split('-')[1] || '';
  const [form, setForm] = useState({
    household: '',
    language: currentLanguage(),
    decimal: guessDecimal(),
    decimal_both: 'last',
    currency: CURRENCY_BY_REGION[region.toUpperCase()] || (currentLanguage() === 'da' ? 'DKK' : 'EUR'),
    members: ['', ''],
    shared_name: t('setup.sharedDefault'),
    password: '',
  });
  const [repeat, setRepeat] = useState('');
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
      const household = await api.post('/api/budgets', { ...form, household: form.household.trim(), members: names });
      setFormat({ language: form.language, currency: form.currency, decimal: form.decimal });
      setStore({ household });
      onDone(household);
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return html`<div class="center-page"><form class="card center-card stack" style="gap:16px" onSubmit=${submit}>
    <div class="logo-row"><${Logo} size=${44} /><div><div class="name">Sparegrisen</div><div class="small secondary">${t('setup.tagline')}</div></div></div>
    <label class="field"><span>${t('settings.language')}</span>
      <select class="input" value=${form.language} onChange=${(e) => changeLanguage(e.target.value)}>
        ${Object.entries(LANGUAGES).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}</select></label>
    <label class="field"><span>${t('settings.householdName')}</span>
      <input class="input" name="username" autocomplete="username" value=${form.household} placeholder=${t('setup.householdPlaceholder')}
        maxlength="100" autofocus onInput=${(e) => set({ household: e.target.value })} />
      <span class="hint">${t('settings.budgetNameHint')}</span></label>
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
      <div class="field"><span>${t('settings.decimal')}</span><${DecimalChoice} value=${form.decimal} onChange=${(decimal) => set({ decimal })}
        both=${form.decimal_both} onBothChange=${(decimal_both) => set({ decimal_both })} /></div>
    </div>
    <div class="field"><span>${t('login.password')}</span>
      <span class="hint">${t('setup.loginHint')}</span>
      <input class="input" type="password" autocomplete="new-password" value=${form.password} placeholder=${t('login.password')}
        aria-label=${t('login.password')} onInput=${(e) => set({ password: e.target.value })} />
      <input class="input" type="password" autocomplete="new-password" value=${repeat} placeholder=${t('setup.passwordRepeat')}
        aria-label=${t('setup.passwordRepeat')} onInput=${(e) => setRepeat(e.target.value)} />
      ${form.password && form.password.length < 8 ? html`<span class="hint bad">${t('setup.passwordShort')}</span>`
        : repeat && repeat !== form.password ? html`<span class="hint bad">${t('setup.passwordMismatch')}</span>` : null}
    </div>
    <button class="btn primary block" disabled=${busy || form.household.trim().length < 2 || !names.length || !form.shared_name.trim()
      || form.password.length < 8 || repeat !== form.password}>${t('setup.start')}</button>
    ${onBack && html`<button type="button" class="btn ghost" onClick=${onBack}>${t('setup.back')}</button>`}
  </form></div>`;
}
