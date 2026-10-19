// "Add to home screen": instructions per platform, and a one-tap install
// button where the browser offers one (Chrome and Edge, not Safari).
import { html, useState, useEffect } from '../lib.js';
import { t } from '../i18n.js';
import { Sheet, Segmented, Icon } from '../ui.js';

let installPrompt = null;
const waiting = new Set();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we offer our own button instead of Chrome's mini bar
  installPrompt = e;
  waiting.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  waiting.forEach((fn) => fn());
});

export function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    waiting.add(fn);
    return () => waiting.delete(fn);
  }, []);
  return installPrompt;
}

/** A browser icon shown inline in the instructions, so people know what to look for. */
function Glyph({ name }) {
  return html`<span class="glyph"><${Icon} name=${name} size=${16} stroke=${2.2} /></span>`;
}

function Steps({ steps }) {
  return html`<ol class="install-steps">${steps.map((s, i) => html`<li key=${i}>${s}</li>`)}</ol>`;
}

export function InstallGuide() {
  const [tab, setTab] = useState(platform());
  const prompt = useInstallPrompt();
  const insecure = location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname);

  if (isInstalled()) {
    return html`<div class="notice good-notice"><${Icon} name="check" size=${18} /> ${t('install.installed')}</div>`;
  }
  const install = async () => {
    prompt.prompt();
    await prompt.userChoice;
    installPrompt = null;
    waiting.forEach((fn) => fn());
  };
  return html`<div class="stack">
    <p class="small secondary" style="margin:0">${t('install.intro')}</p>
    <${Segmented} value=${tab} onChange=${setTab} label=${t('install.title')}
      options=${[{ value: 'ios', label: 'iPhone / iPad' }, { value: 'android', label: 'Android' }, { value: 'desktop', label: t('install.computer') }]} />
    ${prompt && tab !== 'ios' && html`<button class="btn primary" style="align-self:flex-start" onClick=${install}>
      <${Icon} name="download" size=${18} />${t('install.now')}</button>`}
    ${tab === 'ios' && html`<${Steps} steps=${[
      t('install.ios1'),
      html`${t('install.ios2a')} <${Glyph} name="share" /> ${t('install.ios2b')}`,
      html`${t('install.ios3a')} <${Glyph} name="addSquare" /> <strong>${t('install.ios3b')}</strong>.`,
      html`${t('install.ios4a')} <strong>${t('install.ios4b')}</strong>.`,
    ]} />`}
    ${tab === 'android' && html`<${Steps} steps=${[
      t('install.android1'),
      html`${t('install.android2a')} <${Glyph} name="dots" /> ${t('install.android2b')}`,
      html`${t('install.android3a')} <strong>${t('install.android3b')}</strong> ${t('install.android3c')}`,
      html`${t('install.android4a')} <strong>${t('install.android4b')}</strong>.`,
    ]} />
      <p class="small muted" style="margin:0">${t('install.androidOther')}</p>`}
    ${tab === 'desktop' && html`<${Steps} steps=${[
      html`${t('install.desktop1a')} <${Glyph} name="install" /> ${t('install.desktop1b')}`,
      t('install.desktop2'),
      t('install.desktop3'),
    ]} />`}
    ${insecure && tab !== 'ios' && html`<p class="small bad" style="margin:0">${t('install.https')}</p>`}
    <p class="small muted" style="margin:0">${t('install.after')}</p>
  </div>`;
}

export function InstallSheet({ onClose }) {
  return html`<${Sheet} title=${t('install.title')} onClose=${onClose}><${InstallGuide} /></${Sheet}>`;
}

const DISMISSED = 'sparegrisen.installTipDismissed';

/** A small tip on phones that haven't added the app to the home screen yet. */
export function InstallTip() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });
  if (hidden || isInstalled() || platform() === 'desktop') return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {}
    setHidden(true);
  };
  return html`<div class="banner">
    <${Icon} name="addSquare" />
    <div class="text"><strong>${t('install.tipTitle')}</strong><div class="small secondary">${t('install.tipText')}</div></div>
    <div class="row">
      <button class="btn small primary" onClick=${() => setOpen(true)}>${t('install.show')}</button>
      <button class="btn small ghost icon" onClick=${dismiss} aria-label=${t('common.close')}><${Icon} name="close" size=${16} /></button>
    </div>
    ${open && html`<${InstallSheet} onClose=${() => setOpen(false)} />`}
  </div>`;
}
