// App-wide state: the household (members, categories, accounts, settings),
// the selected year and month, and a version number that every data hook
// watches, so one bump() after a change refreshes every view.
import { useState, useEffect, useRef } from './lib.js';
import { api } from './api.js';
import { setLanguage } from './i18n.js';
import { setLocale } from './fmt.js';

const now = new Date();
const saved = (key, fallback) => {
  try {
    const v = localStorage.getItem('nestegg.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem('nestegg.' + key, JSON.stringify(value));
  } catch {}
};

const store = {
  household: null, // response of /api/state
  year: now.getFullYear(),
  month: now.getMonth() + 1,
  planMember: saved('planMember', null),
  monthMember: saved('monthMember', null),
  theme: saved('theme', 'auto'),
  version: 0,
};
const subscribers = new Set();

export function getStore() {
  return store;
}

export function setStore(patch) {
  Object.assign(store, patch);
  for (const key of ['planMember', 'monthMember', 'theme']) if (key in patch) save(key, patch[key]);
  subscribers.forEach((fn) => fn());
}

/** Re-render when the store changes. */
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }, []);
  return store;
}

/** Tell every view its data may be stale. */
export function bump() {
  setStore({ version: store.version + 1 });
}

export async function reloadHousehold() {
  const household = await api.get('/api/state');
  setStore({ household });
  return household;
}

/**
 * Fetch url, and again whenever it changes or bump() is called. While
 * refetching, the previous data stays in place (no flash of empty content).
 */
export function useData(url) {
  const { version } = useStore();
  const [state, setState] = useState({ data: null, error: null, loading: true, url: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (!url) return;
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    api.get(url).then(
      (data) => id === latest.current && setState({ data, error: null, loading: false, url }),
      (error) => id === latest.current && setState((s) => ({ ...s, error, loading: false })),
    );
  }, [url, version, tick]);
  // Data for a different url than requested is stale: report it as loading.
  const stale = state.url !== url;
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    stale,
    reload: () => setTick((n) => n + 1),
    set: (data) => setState((s) => ({ ...s, data: typeof data === 'function' ? data(s.data) : data })),
  };
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0d0d0d' : '#f6f5f2'));
}

/** Apply the household's language and number format everywhere. */
export function applySettings(settings = {}) {
  setLanguage(settings.language || navigator.language);
  setLocale(settings.locale, settings.currency);
  document.documentElement.lang = settings.language || 'en';
}
