import { html } from '../lib.js';
import { useStore, useData, setStore } from '../store.js';
import { t } from '../i18n.js';
import { money, signedMoney, percent, monthNames, sum } from '../fmt.js';
import { ColumnChart, LineChart, BarList, ChartCard, ChartTable, Legend } from '../charts.js';
import { Dot, Empty, Icon, seriesColor } from '../ui.js';
import { members, memberById, memberColor, categoryById, accountById, INCOME_COLOR, EXPENSE_COLOR, referenceMonth, monthTotals } from '../model.js';
import { CopyYearBanner } from './plan.js';

function Tile({ label, value, delta }) {
  return html`<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${delta && html`<div class="delta">${delta}</div>`}</div>`;
}

function netClass(v) {
  return v > 0.5 ? 'good' : v < -0.5 ? 'bad' : '';
}

export function Overview() {
  const { year, household } = useStore();
  const summary = useData(`/api/summary/${year}`);
  const items = useData(`/api/years/${year}/items`);
  const s = summary.data;
  if (!s || !items.data) return html`<div class="loading">${t('common.loading')}</div>`;

  const short = monthNames('short');
  const long = monthNames('long');
  const income = sum(s.income);
  const expense = sum(s.expense);
  const net = income - expense;
  const saved = sum(s.savings) + net;
  const activeMonths = s.income.filter((v, i) => v || s.expense[i]).length || 12;
  const fixed = sum(s.fixed);

  if (!items.data.length) {
    return html`<${CopyYearBanner} year=${year} />
      <div class="card"><${Empty} title=${t('overview.emptyTitle', { year })}>
        <p>${t('overview.emptyText')}</p>
        <div class="row wrap" style="justify-content:center">
          <a class="btn primary" href="#/plan"><${Icon} name="plus" size=${18} />${t('overview.startBudget')}</a>
          <a class="btn" href="#/settings"><${Icon} name="upload" size=${18} />${t('overview.importSheet')}</a>
        </div>
        ${household.years.length > 0 && html`<p class="small" style="margin-top:20px">${t('overview.otherYears')}
          ${household.years.map((y) => html` <button class="btn small" key=${y} onClick=${() => setStore({ year: y })}>${y}</button>`)}</p>`}
      </${Empty}></div>`;
  }

  const refMonth = referenceMonth(year);
  const isThisYear = year === new Date().getFullYear();
  const thisMonth = monthTotals(items.data, refMonth);
  const itemsById = Object.fromEntries(items.data.map((i) => [i.id, i]));

  const monthSeries = [
    { name: t('common.income'), color: INCOME_COLOR, values: s.income },
    { name: t('common.expenses'), color: EXPENSE_COLOR, values: s.expense },
  ];
  const balanceSeries = [{ name: t('overview.accumulated'), color: seriesColor(0), values: s.cumulative }];

  // Per person
  const memberRows = members(household, { archived: true })
    .map((m) => {
      const d = s.members.find((x) => x.id === m.id);
      return d && { m, income: sum(d.income), expense: sum(d.expense) };
    })
    .filter((r) => r && (r.income || r.expense));

  // Categories: largest first, the tail folded into "Other".
  const cats = s.categories
    .filter((c) => c.kind === 'expense' && c.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((c) => ({ key: c.id ?? 'none', label: c.id ? categoryById(household, c.id)?.name : t('common.uncategorized'), value: c.total }));
  const catRows = cats.length > 9 ? [...cats.slice(0, 8), { key: 'rest', label: t('common.other'), value: sum(cats.slice(8).map((c) => c.value)) }] : cats;

  const accounts = s.accounts
    .map((a) => ({ ...a, account: accountById(household, a.id) }))
    .filter((a) => a.account && !a.account.archived);

  return html`<div class=${summary.loading ? 'refetching' : ''}>
    ${isThisYear && html`<a href="#/month" onClick=${() => setStore({ month: refMonth + 1 })} class="card" style="display:block;text-decoration:none;color:inherit;margin-bottom:12px">
      <div class="card-head" style="margin-bottom:8px"><h2 style="text-transform:capitalize">${long[refMonth]}</h2><span class="muted small">${t('overview.editMonth')}</span><${Icon} name="right" size=${18} /></div>
      <div class="sum-strip">
        <div><div class="label"><${Dot} color=${INCOME_COLOR} size=${8} />${t('common.income')}</div><div class="value">${money(thisMonth.income)}</div></div>
        <div><div class="label"><${Dot} color=${EXPENSE_COLOR} size=${8} />${t('common.expenses')}</div><div class="value">${money(thisMonth.expense)}</div></div>
        <div><div class="label">${t('common.balance')}</div><div class=${'value ' + netClass(thisMonth.net)}>${signedMoney(thisMonth.net)}</div></div>
      </div>
    </a>`}

    <section class="card hero">
      <div class="label">${t('overview.yearBalance', { year })}</div>
      <div class=${'value ' + netClass(net)}>${signedMoney(net)}</div>
      <div class="sub">
        <span class="key"><${Dot} color=${INCOME_COLOR} size=${8} />${t('common.income')} ${money(income)}</span>
        <span class="key"><${Dot} color=${EXPENSE_COLOR} size=${8} />${t('common.expenses')} ${money(expense)}</span>
      </div>
    </section>

    <div class="tiles">
      <${Tile} label=${t('overview.avgIncome')} value=${money(income / activeMonths)} delta=${t('overview.perMonth')} />
      <${Tile} label=${t('overview.avgExpenses')} value=${money(expense / activeMonths)} delta=${t('overview.perMonth')} />
      <${Tile} label=${t('overview.saved')} value=${money(saved)} delta=${income ? t('overview.ofIncome', { pct: percent(saved / income) }) : ''} />
      ${fixed > 0
        ? html`<${Tile} label=${t('overview.fixed')} value=${percent(fixed / expense)} delta=${t('overview.fixedHint', { amount: money(fixed) })} />`
        : html`<${Tile} label=${t('overview.surplusMonths')} value=${`${s.net.filter((v, i) => v > 0.5).length} / ${activeMonths}`} delta=${t('overview.surplusHint')} />`}
    </div>

    <div class="section-gap"></div>
    <div class="grid-2">
      <${ChartCard} title=${t('overview.perMonthTitle')} className="span-2"
        table=${html`<${ChartTable} labels=${long} series=${[...monthSeries, { name: t('common.balance'), values: s.net }]} />`}>
        <${Legend} series=${monthSeries} />
        <${ColumnChart} labels=${short} titles=${long} series=${monthSeries} height=${230} label=${t('overview.perMonthTitle')}
          extraRow=${(i) => html`<div class="t-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px">
            <span class="t-key"></span><span class=${'t-value ' + netClass(s.net[i])}>${signedMoney(s.net[i])}</span><span class="t-name">${t('common.balance')}</span></div>`} />
      </${ChartCard}>

      <${ChartCard} title=${t('overview.accumulated')}
        table=${html`<${ChartTable} labels=${long} total=${false} series=${[{ name: t('common.balance'), values: s.net }, { name: t('overview.accumulated'), values: s.cumulative }]} />`}>
        <p class="small secondary" style="margin:-6px 0 8px">${t('overview.accumulatedHint')}</p>
        <${LineChart} labels=${short} titles=${long} series=${balanceSeries} area zero height=${190} label=${t('overview.accumulated')} />
      </${ChartCard}>

      ${accounts.length > 0 && html`<${ChartCard} title=${t('overview.accounts')}
        table=${html`<${ChartTable} labels=${long} total=${false} series=${accounts.map((a) => ({ name: a.account.name, values: a.balances }))} />`}>
        ${accounts.map((a) => {
          const value = a.balances[refMonth];
          const known = a.balances.some((v) => v != null);
          return html`<div key=${a.id} style="margin-bottom:10px">
            <div class="row"><${Dot} color=${seriesColor(a.account.color)} /><strong class="spacer ellipsis">${a.account.name}</strong>
              <span class="num" style="font-weight:650">${money(value)}</span></div>
            <div class="small muted" style="margin:0 0 4px 18px">
              ${known ? t('overview.accountAt', { month: long[refMonth] }) : t('overview.accountUnknown')}
              ${a.manual[refMonth] && html` · <span class="badge accent">${t('month.actual')}</span>`}</div>
            ${known && html`<${LineChart} labels=${short} titles=${long} series=${[{ name: a.account.name, color: seriesColor(a.account.color), values: a.balances }]} height=${130} label=${a.account.name} />`}
          </div>`;
        })}
      </${ChartCard}>`}

      ${memberRows.length > 0 && html`<section class="card">
        <div class="card-head"><h2>${t('overview.byPerson')}</h2></div>
        <div class="list" style="margin:0 -16px">${memberRows.map((r) => html`<div class="list-row" key=${r.m.id}>
          <${Dot} color=${seriesColor(r.m.color)} />
          <div class="main-col"><div class="name">${r.m.name}</div>
            <div class="meta">${r.income ? `${t('common.income')} ${money(r.income)} · ` : ''}${t('common.expenses')} ${money(r.expense)}</div></div>
          <div class=${'amount ' + netClass(r.income - r.expense)}>${signedMoney(r.income - r.expense)}</div>
        </div>`)}</div>
        <div style="margin-top:16px"><${BarList} rows=${memberRows.filter((r) => r.expense).sort((a, b) => b.expense - a.expense).map((r) => ({ key: r.m.id, label: r.m.name, color: seriesColor(r.m.color), value: r.expense, sub: percent(r.expense / expense) }))} /></div>
        <p class="small muted" style="margin:10px 0 0">${t('overview.byPersonHint')}</p>
      </section>`}

      ${catRows.length > 0 && html`<section class="card">
        <div class="card-head"><h2>${t('overview.byCategory')}</h2></div>
        ${catRows.length === 1 && catRows[0].key === 'none'
          ? html`<p class="secondary small" style="margin:0">${t('overview.noCategories')}</p>`
          : html`<${BarList} rows=${catRows.map((c) => ({ ...c, color: EXPENSE_COLOR, sub: percent(c.value / expense) }))} />`}
      </section>`}

      ${s.top_expenses.length > 0 && html`<section class="card flush">
        <div class="card-head"><h2>${t('overview.largest')}</h2></div>
        <div class="list">${s.top_expenses.map((x) => {
          const item = itemsById[x.item_id];
          if (!item) return null;
          return html`<div class="list-row" key=${x.item_id}>
            <${Dot} color=${memberColor(household, item.member_id)} />
            <div class="main-col"><div class="name">${item.name}</div>
              <div class="meta">${memberById(household, item.member_id)?.name}${item.category_id ? ' · ' + (categoryById(household, item.category_id)?.name || '') : ''}</div></div>
            <div style="text-align:right"><div class="amount">${money(x.total)}</div><div class="small muted">${percent(x.total / expense)}</div></div>
          </div>`;
        })}</div>
      </section>`}
    </div>
  </div>`;
}
