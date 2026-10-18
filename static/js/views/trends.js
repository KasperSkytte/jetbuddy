import { html } from '../lib.js';
import { useStore, useData } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, percent, monthNames } from '../fmt.js';
import { ColumnChart, LineChart, ChartCard, ChartTable, Legend } from '../charts.js';
import { Empty, seriesColor } from '../ui.js';
import { members, INCOME_COLOR, EXPENSE_COLOR } from '../model.js';
import { ReliabilityBanner } from './checks.js';

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

  const people = members(household, { archived: true }).filter((m) => data.some((y) => y.members.some((x) => x.id === m.id && x.expense)));
  const personSeries = people.map((m) => ({ name: m.name, color: seriesColor(m.color), values: data.map((y) => y.members.find((x) => x.id === m.id)?.expense || 0) }))

  return html`<div class=${trends.loading ? 'refetching' : ''}>
    <${ReliabilityBanner} />
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

      <section class="card flush span-2">
        <div class="card-head"><h2>${t('trends.table')}</h2></div>
        <div class="list">${[...data].reverse().map((y) => html`<div class="list-row" key=${y.year}>
          <div class="main-col"><div class="name">${y.year}</div>
            <div class="meta" style="white-space:normal">${t('common.income')} ${money(y.income)} · ${t('common.expenses')} ${money(y.expense)} · ${t('trends.toSavings')} ${money(y.savings)}</div></div>
          <div style="text-align:right"><div class=${'amount ' + (y.net > 0.5 ? 'good' : y.net < -0.5 ? 'bad' : '')}>${signedMoney(y.net)}</div>
            <div class="small muted">${y.income ? t('trends.rate', { pct: percent((y.savings + y.net) / y.income) }) : ''}</div></div>
        </div>`)}</div>
        <p class="small muted" style="margin:0;padding:4px 16px 14px">${t('trends.rateHint')}</p>
      </section>

      ${people.length > 0 && html`<${ChartCard} title=${t('trends.byPerson')} className="span-2"
        table=${html`<${ChartTable} labels=${labels} series=${personSeries} total=${false} />`}>
        <${Legend} series=${personSeries} />
        <${ColumnChart} labels=${labels} series=${personSeries} label=${t('trends.byPerson')} />
      </${ChartCard}>`}
    </div>
  </div>`;
}
