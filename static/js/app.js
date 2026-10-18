import { html, render, useState, useEffect } from './lib.js';
import { api, onUnauthorized } from './api.js';
import { useStore, setStore, reloadHousehold, applyTheme, getStore, applySettings } from './store.js';
import { t } from './i18n.js';
import { Icon, Logo, YearStepper, toastError } from './ui.js';
import { Overview } from './views/overview.js';
import { Month } from './views/month.js';
import { Plan } from './views/plan.js';
import { Trends } from './views/trends.js';
import { Settings } from './views/settings.js';
import { Setup } from './views/setup.js';
import { Login } from './views/login.js';

const PAGES = [
  { path: '', icon: 'overview', title: 'nav.overview', view: Overview },
  { path: 'month', icon: 'month', title: 'nav.month', view: Month },
  { path: 'plan', icon: 'plan', title: 'nav.plan', view: Plan },
  { path: 'trends', icon: 'trends', title: 'nav.trends', view: Trends, noYear: true },
  { path: 'settings', icon: 'settings', title: 'nav.settings', view: Settings, noYear: true },
];

function currentPath() {
  return location.hash.replace(/^#\/?/, '').split('?')[0];
}

function useRoute() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const fn = () => {
      setPath(currentPath());
      window.scrollTo(0, 0);
    };
    addEventListener('hashchange', fn);
    return () => removeEventListener('hashchange', fn);
  }, []);
  return path;
}

function Shell() {
  const store = useStore();
  const path = useRoute();
  const page = PAGES.find((p) => p.path === path) || PAGES[0];
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const fn = () => setScrolled(scrollY > 4);
    addEventListener('scroll', fn, { passive: true });
    return () => removeEventListener('scroll', fn);
  }, []);
  useEffect(() => {
    document.title = `${t(page.title)} · Jetbuddy`;
  }, [page, store.household]);
  const View = page.view;
  return html`<div class="shell">
    <nav class="nav" aria-label=${t('nav.label')}>
      <div class="brand"><${Logo} size=${30} /> Jetbuddy</div>
      ${PAGES.map((p) => html`<a key=${p.path} href=${'#/' + p.path} class=${p === page ? 'active' : ''} aria-current=${p === page ? 'page' : null}>
        <span class="icon-wrap"><${Icon} name=${p.icon} /></span>${t(p.title)}</a>`)}
    </nav>
    <div>
      <header class=${'topbar' + (scrolled ? ' scrolled' : '')}>
        <div class="spacer">
          <div class="household">${store.household.settings.household}</div>
          <h1 class="title">${t(page.title)}</h1>
        </div>
        ${!page.noYear && html`<${YearStepper} year=${store.year} onChange=${(year) => setStore({ year })} />`}
      </header>
      <main class="main"><${View} /></main>
    </div>
  </div>`;
}

function App() {
  const store = useStore();
  const [phase, setPhase] = useState('loading'); // loading | login | setup | ready | error
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);

  const boot = async () => {
    try {
      const session = await api.get('/api/session');
      setSession(session);
      setStore({ session });
      if (!session.logged_in) {
        applySettings({});
        setPhase(session.has_budgets ? 'login' : 'setup');
        return;
      }
      const household = await reloadHousehold();
      applySettings(household.settings);
      setPhase('ready');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  };

  useEffect(() => {
    applyTheme(getStore().theme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getStore().theme));
    boot();
    return onUnauthorized(() => boot());
  }, []);

  if (phase === 'loading') return html`<div class="loading"><${Logo} size=${48} /></div>`;
  if (phase === 'login') return html`<${Login} canCreate=${session?.can_create} onDone=${boot} onCreate=${() => setPhase('setup')} />`;
  if (phase === 'setup') return html`<${Setup} onDone=${boot} onBack=${session?.has_budgets ? () => setPhase('login') : null} />`;
  if (phase === 'error')
    return html`<div class="center-page"><div class="card center-card">
      <h2>${t('error.title')}</h2><p class="secondary">${error?.message === 'offline' ? t('error.offline') : String(error?.message || error)}</p>
      <button class="btn primary" onClick=${() => { setPhase('loading'); boot(); }}>${t('common.retry')}</button></div></div>`;
  return html`<${Shell} />`;
}

render(html`<${App} />`, document.getElementById('app'));

// Service workers only run on https (or localhost); on plain http the app still works, just not offline.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.addEventListener('unhandledrejection', (e) => toastError(e.reason));
