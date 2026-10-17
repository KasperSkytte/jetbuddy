import { html } from '../lib.js';
import { useStore, useData } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, percent, monthNames } from '../fmt.js';
import { ColumnChart, LineChart, ChartCard, ChartTable, Legend } from '../charts.js';
import { Dot, Empty, seriesColor } from '../ui.js';
import { members, accountById, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';

export function Trends() {
  const { year, household } = useStore();
  const trends = useData('/api/trends');
  const thisYear = useData(`/api/summary/${year}`);
  const lastYear = useData(`/api/summary/${year - 1}`);
  const data = trends.data;
  if (!data) return html`<div class="loading">${t('common.loading')}</div>`;
  if (!data.length) return html`<div class="card"><${Empty} title=${t('trends.emptyTitle')}><p>${t('trends.emptyText')}</p></${Empty}></div>`;

  const labels = data.map((y) => String(y.year));
  const yearSeries = [
    { name: t('common.income'), color: INCOME_COLOR, values: data.map((y) => y.income) },
    { name: t('common.expenses'), color: EXPENSE_COLOR, values: data.map((y) => y.expense) },
  ];
  const resultSeries = [
    { name: t('common.balance'), color: seriesColor(0), values: data.map((y) => y.net) },
    { name: t('trends.toSavings'), color: seriesColor(2), values: data.map((y) => y.savings) },
  ];
  const accounts = household.accounts.filter((a) => !a.archived && data.filter((y) => y.accounts[a.id] != null).length >= 2);
  const accountSeries = accounts.map((a) => ({ name: a.name, color: seriesColor(a.color), values: data.map((y) => y.accounts[a.id] ?? null) }));

  const short = monthNames('short');
  const long = monthNames('long');
  const compare = thisYear.data && lastYear.data && lastYear.data.has_data && [
    { name: String(year - 1), color: seriesColor(6), values: lastYear.data.expense },
    { name: String(year), color: EXPENSE_COLOR, values: thisYear.data.expense },
  ];

  const people = members(household, { archived: true }).filter((m) => data.some((y) => y.members.some((x) => x.id === m.id && (x.expense || x.income))));

  return html`<div class=${trends.loading ? 'refetching' : ''}>
    <div class="grid-2">
      <${ChartCard} title=${t('trends.perYear')} table=${html`<${ChartTable} labels=${labels} series=${yearSeries} total=${false} />`}>
        <${Legend} series=${yearSeries} />
        <${ColumnChart} labels=${labels} series=${yearSeries} label=${t('trends.perYear')} />
      </${ChartCard}>
      <${ChartCard} title=${t('trends.result')} table=${html`<${ChartTable} labels=${labels} series=${resultSeries} total=${false} />`}>
        <${Legend} series=${resultSeries} />
        <${ColumnChart} labels=${labels} series=${resultSeries} label=${t('trends.result')} />
      </${ChartCard}>
      ${compare && html`<${ChartCard} title=${t('trends.compare', { a: year, b: year - 1 })} table=${html`<${ChartTable} labels=${long} series=${compare} />`}>
        <${Legend} series=${compare} type="line" />
        <${LineChart} labels=${short} titles=${long} series=${compare} zero label=${t('trends.compare', { a: year, b: year - 1 })} />
      </${ChartCard}>`}
      ${accountSeries.length > 0 && html`<${ChartCard} title=${t('trends.accounts')} table=${html`<${ChartTable} labels=${labels} series=${accountSeries} total=${false} />`}>
        <${Legend} series=${accountSeries} type="line" />
        <${LineChart} labels=${labels} series=${accountSeries} zero label=${t('trends.accounts')} />
      </${ChartCard}>`}

      <section class="card span-2">
        <div class="card-head"><h2>${t('trends.table')}</h2></div>
        <div class="table-scroll"><table class="data">
          <thead><tr><th></th><th>${t('common.income')}</th><th>${t('common.expenses')}</th><th>${t('common.balance')}</th><th>${t('trends.toSavings')}</th><th>${t('trends.savingsRate')}</th></tr></thead>
          <tbody>${[...data].reverse().map((y) => html`<tr key=${y.year}>
            <td><strong>${y.year}</strong></td><td>${money(y.income)}</td><td>${money(y.expense)}</td>
            <td class=${y.net > 0.5 ? 'good' : y.net < -0.5 ? 'bad' : ''}>${signedMoney(y.net)}</td>
            <td>${money(y.savings)}</td><td>${y.income ? percent((y.savings + y.net) / y.income) : '–'}</td></tr>`)}
          </tbody></table></div>
        <p class="small muted" style="margin:10px 0 0">${t('trends.rateHint')}</p>
      </section>

      ${people.length > 0 && html`<section class="card span-2">
        <div class="card-head"><h2>${t('trends.byPerson')}</h2></div>
        <div class="table-scroll"><table class="data">
          <thead><tr><th></th>${people.map((m) => html`<th key=${m.id}><span class="row" style="justify-content:flex-end"><${Dot} color=${seriesColor(m.color)} size=${8} />${m.name}</span></th>`)}</tr></thead>
          <tbody>${[...data].reverse().map((y) => html`<tr key=${y.year}><td><strong>${y.year}</strong></td>
            ${people.map((m) => html`<td key=${m.id}>${money(y.members.find((x) => x.id === m.id)?.expense || 0)}</td>`)}</tr>`)}
          </tbody></table></div>
      </section>`}
    </div>
  </div>`;
}
