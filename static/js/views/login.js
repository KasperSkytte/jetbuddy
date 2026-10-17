import { html, useState } from '../lib.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { Logo } from '../ui.js';

export function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/login', { password });
      onDone();
    } catch (err) {
      setError(err.status === 401 ? t('login.wrong') : err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="center-page"><form class="card center-card stack" onSubmit=${submit}>
    <div class="logo-row"><${Logo} size=${44} /><span class="name">Nestegg</span></div>
    <label class="field"><span>${t('login.password')}</span>
      <input class="input" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} autofocus /></label>
    ${error && html`<div class="bad small">${error}</div>`}
    <button class="btn primary block" disabled=${busy || !password}>${t('login.submit')}</button>
  </form></div>`;
}
