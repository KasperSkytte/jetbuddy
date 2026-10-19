// Lookups over the household data from /api/state.
import { seriesColor } from './ui.js';
import { t, currentLanguage } from './i18n.js';
import { amount, monthNames } from './fmt.js';

export function members(household, { archived = false } = {}) {
  return household.members.filter((m) => archived || !m.archived);
}

export function memberById(household, id) {
  return household.members.find((m) => m.id === id);
}

export function memberColor(household, id) {
  const m = memberById(household, id);
  return seriesColor(m ? m.color : 0);
}

export function categoryById(household, id) {
  return household.categories.find((c) => c.id === id);
}

export function categories(household, kind) {
  return household.categories.filter((c) => c.kind === kind);
}

export function accountById(household, id) {
  return household.accounts.find((a) => a.id === id);
}

export const INCOME_COLOR = 'var(--income)';
export const EXPENSE_COLOR = 'var(--expense)';

/** Items of one member, income first, in their saved order. */
export function itemsOf(items, memberId) {
  const own = items.filter((i) => i.member_id === memberId);
  return [...own.filter((i) => i.kind === 'income'), ...own.filter((i) => i.kind === 'expense')];
}

export function monthTotals(items, monthIndex) {
  let income = 0;
  let expense = 0;
  for (const i of items) {
    const v = i.amounts[monthIndex];
    if (v == null) continue;
    if (i.kind === 'income') income += v;
    else expense += v;
  }
  return { income, expense, net: income - expense };
}

/** The month a year's "current" figures refer to: this month for this year, else December. */
export function referenceMonth(year) {
  const now = new Date();
  return year === now.getFullYear() ? now.getMonth() : 11;
}

// ------------------------------------------------------------------ repeating amounts
// Items store one amount per month. Most follow a rhythm ("2,500 every month",
// "880 every quarter from February"), so the editor works in those terms and
// only falls back to month by month when the amounts vary.

export const EVERY = [1, 2, 3, 4, 6, 12];

/** The 12 monthly values a rhythm produces. */
export function applyPattern({ every, from, to }, value) {
  return Array.from({ length: 12 }, (_, i) => (value != null && i >= from && i <= to && (i - from) % every === 0 ? value : null));
}

/** The rhythm behind 12 monthly values, or null if the amounts vary. */
export function detectPattern(values) {
  const months = values.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
  if (!months.length) return null;
  const value = values[months[0]];
  if (months.some((i) => values[i] !== value)) return null;
  const every = months.length === 1 ? 12 : months[1] - months[0];
  if (!EVERY.includes(every)) return null;
  for (let k = 1; k < months.length; k++) if (months[k] - months[k - 1] !== every) return null;
  const last = months[months.length - 1];
  return { value, every, from: months[0], to: last + every > 11 ? 11 : last };
}

/** "2,500 every month", "880 in Feb, May, Aug, Nov", or "Varies". */
export function describeAmounts(values) {
  const p = detectPattern(values);
  if (!values.some((v) => v != null)) return t('pattern.none');
  if (!p) {
    // "Mostly 31,250" when one amount covers most months, e.g. a salary with a bonus month.
    const counts = new Map();
    values.forEach((v) => v != null && counts.set(v, (counts.get(v) || 0) + 1));
    const [common, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return n >= 3 ? t('pattern.mostly', { amount: amount(common) }) : t('pattern.varies');
  }
  const short = monthNames('short');
  if (p.every === 1) {
    const whole = p.from === 0 && p.to === 11;
    return t('pattern.monthly', { amount: amount(p.value) }) + (whole ? '' : ` (${short[p.from]}–${short[p.to]})`);
  }
  const months = values.map((v, i) => (v != null ? short[i] : null)).filter(Boolean);
  return t('pattern.in', { amount: amount(p.value), months: months.join(', ') });
}

// ------------------------------------------------------------------ sorting

const collator = () => new Intl.Collator(currentLanguage() === 'da' ? 'da' : 'en', { sensitivity: 'base', numeric: true });

/**
 * Items in the chosen order: 'custom' (as arranged), 'amount' (largest first:
 * the month's amount when month is given, else the year's total), 'name', or
 * 'category' (then name).
 */
export function sortItems(items, by, { month, household } = {}) {
  if (by === 'custom' || !by) return items;
  const c = collator();
  const total = (i) => (month ? i.amounts[month - 1] ?? -Infinity : i.amounts.reduce((s, v) => s + (v || 0), 0));
  const cat = (i) => (i.category_id && categoryById(household, i.category_id)?.name) || '\uffff'; // uncategorised last
  const byName = (a, b) => c.compare(a.name, b.name);
  const sorted = [...items];
  if (by === 'amount') sorted.sort((a, b) => total(b) - total(a) || byName(a, b));
  else if (by === 'name') sorted.sort(byName);
  else if (by === 'category') sorted.sort((a, b) => c.compare(cat(a), cat(b)) || byName(a, b));
  return sorted;
}

// ------------------------------------------------------------------ month-end balances

/** The day a month's balance is read (see the server's measure_day), as "29. oktober". */
export function measureDay(year, month, mode) {
  const end = new Date(year, month, 0);
  if (mode === 'before_payday') {
    while (end.getDay() === 0 || end.getDay() === 6) end.setDate(end.getDate() - 1);
    end.setDate(end.getDate() - 1);
  }
  return end;
}

export function measureDate(year, month, mode) {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { day: 'numeric', month: 'long' }).format(measureDay(year, month, mode));
}

/** "End of October", or "Before payday, October": what a month's balance means. */
export function balanceLabel(household, month) {
  return t(household.settings.balance_day === 'before_payday' ? 'overview.beforePayday' : 'overview.endOf', { month });
}
