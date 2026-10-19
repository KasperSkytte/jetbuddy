// Accounts: each account's balance after every bank transaction this year,
// and the transactions themselves. The Overview shows month ends only.
import { html, useState } from '../lib.js';
import { useStore, useData } from '../store.js';
import { t } from '../i18n.js';
import { money, amount, monthNames } from '../fmt.js';
import { LineChart, TrailChart } from '../charts.js';
import { Dot, Empty, Icon, Segmented, seriesColor } from '../ui.js';
import { balanceLabel } from '../model.js';

const SHOWN = 12;
const PERIODS = [1, 3, 6, 12]; // months back from the latest balance

/** The trail from `months` months before its last point; the balance at the
 * start is carried in as a first point, so the line starts at the right level. */
function zoom(trail, months) {
  if (months >= 12 || trail.length < 2) return trail;
  const end = new Date(trail[trail.length - 1].date + 'T12:00:00');
  const from = new Date(end.getFullYear(), end.getMonth() - months, end.getDate(), 12);
  const iso = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const inside = trail.filter((p) => p.date >= iso);
  const before = trail.filter((p) => p.date < iso).pop();
  return before ? [{ ...before, date: iso, amount: null, text: null, via: null }, ...inside] : inside;
}

function day(iso, month = 'long') {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { day: 'numeric', month }).format(new Date(iso + 'T12:00:00'));
}

function AccountCard({ account, summary, year, period }) {
  const { household } = useStore();
  const history = useData(`/api/accounts/${account.id}/history?year=${year}`);
  const [all, setAll] = useState(false);
  const color = seriesColor(account.color);
  const full = history.data || [];
  const trail = zoom(full, period);
  const txs = trail.filter((p) => p.amount != null).reverse(); // newest first
  const latest = trail[trail.length - 1];
  const months = summary?.accounts.find((a) => a.id === account.id);
  const short = monthNames('short');
  const long = monthNames('long');
  const kind = { main: 'settings.mainAccount', savings: 'settings.savingsAccount', expense: 'settings.expenseAccount' }[account.kind];
  return html`<section class="card" style="margin-bottom:12px">
    <div class="row"><${Dot} color=${color} size=${12} /><h2 class="spacer ellipsis">${account.name}</h2>
      ${latest && html`<span class="num" style="font-weight:700;font-size:18px">${money(latest.balance)}</span>`}</div>
    <div class="small muted" style="margin:2px 0 8px 22px">${t(kind)}${latest ? ' · ' + t('accounts.today', { date: day(latest.date) }) : ''}</div>
    ${!history.data ? html`<p class="muted small">${t('common.loading')}</p>`
      : full.length > 1 ? html`<${TrailChart} points=${trail} color=${color} label=${account.name} height=${190} />`
      : html`<p class="small secondary" style="margin:0 0 8px">${t('accounts.noBank')}</p>
        ${months?.balances.some((v) => v != null) && html`<${LineChart} labels=${short} titles=${long.map((m) => balanceLabel(household, m))}
          series=${[{ name: account.name, color, values: months.balances }]} height=${150} label=${account.name} />`}`}
    ${history.data && full.length > 1 && html`<div class="group-label" style="padding-left:0;margin-top:8px">${t('accounts.transactions')}</div>
      ${txs.length === 0 ? html`<p class="small muted" style="margin:0">${t('accounts.noTransactions')}</p>` : html`
        <div class="list" style="margin:0 -16px">${(all ? txs : txs.slice(0, SHOWN)).map((p, i) => html`<div class="list-row tx-line" key=${i}>
          <div class="main-col"><div class="name ellipsis" style="font-weight:520">${p.text || '–'}</div>
            <div class="meta">${p.via && html`<span class="via">${p.via}</span>`} ${day(p.date, 'short')} · ${t('accounts.after')} ${money(p.balance)}</div></div>
          <span class=${'num ' + (p.amount > 0 ? 'good' : '')} style="font-weight:650">${p.amount > 0 ? '+' : ''}${amount(p.amount)}</span>
        </div>`)}</div>
        ${txs.length > SHOWN && html`<button class="add-row" style="margin:0 -16px;width:calc(100% + 32px);color:var(--text-2)" onClick=${() => setAll(!all)}>
          <${Icon} name=${all ? 'up' : 'down'} size=${18} />${all ? t('accounts.showFewer') : t('accounts.showAll', { n: txs.length })}</button>`}`}`}
  </section>`;
}

export function Accounts() {
  const { year, household } = useStore();
  const summary = useData(`/api/summary/${year}`);
  const [period, setPeriod] = useState(12);
  const accounts = household.accounts.filter((a) => !a.archived);
  if (!accounts.length) return html`<div class="card"><${Empty} title=${t('accounts.none')} /></div>`;
  return html`<div>
    <p class="small secondary" style="margin:0 0 10px">${t('accounts.intro')}</p>
    <div class="field" style="margin-bottom:12px"><${Segmented} value=${period} onChange=${setPeriod} label=${t('accounts.period')}
      options=${PERIODS.map((n) => ({ value: n, label: t('accounts.p' + n) }))} /></div>
    <div class="grid-2">${accounts.map((a) => html`<${AccountCard} key=${a.id} account=${a} summary=${summary.data} year=${year} period=${period} />`)}</div>
  </div>`;
}
