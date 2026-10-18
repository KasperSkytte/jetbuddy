import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { Logo } from '../ui.js';

export function Login({ canCreate, onDone, onCreate }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/login', { login, password });
      onDone();
    } catch (err) {
      setError(err.status === 401 ? t('login.wrong') : err.status === 429 ? t('login.tooMany') : err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="center-page"><div class="center-card">
    <form class="card stack" onSubmit=${submit}>
      <div class="logo-row"><${Logo} size=${44} /><span class="name">Jetbuddy</span></div>
      <label class="field"><span>${t('login.username')}</span>
        <input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"
          value=${login} onInput=${(e) => setLogin(e.target.value)} autofocus /></label>
      <label class="field"><span>${t('login.password')}</span>
        <input class="input" type="password" name="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} /></label>
      ${error && html`<div class="bad small">${error}</div>`}
      <button class="btn primary block" disabled=${busy || !login || !password}>${t('login.submit')}</button>
      <p class="small muted" style="margin:0">${t('login.hint')}</p>
    </form>
    ${canCreate && html`<p style="text-align:center"><button class="btn ghost" onClick=${onCreate}>${t('login.newBudget')}</button></p>`}
  </div></div>`;
}
