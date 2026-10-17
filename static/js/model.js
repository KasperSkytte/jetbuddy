// Lookups over the household data from /api/state.
import { seriesColor } from './ui.js';

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
