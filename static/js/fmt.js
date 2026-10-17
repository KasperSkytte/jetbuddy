// Number formatting and parsing in the household's locale and currency.

let fmt = null;

export function setLocale(locale, currency) {
  locale = locale || navigator.language || 'en-US';
  currency = currency || 'USD';
  let money, moneyShort, plain, compact, pct;
  try {
    money = new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 });
  } catch {
    money = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  }
  try {
    moneyShort = new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
  } catch {
    moneyShort = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  }
  plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
  const decimal = parts.find((p) => p.type === 'decimal')?.value || '.';
  fmt = { locale, currency, money, moneyShort, plain, compact, pct, decimal };
}

setLocale();

export const locale = () => fmt.locale;

/** 12 345 kr. - for totals. Rounded to whole units. */
export function money(v) {
  if (v == null || Number.isNaN(v)) return '–';
  // Avoid "-0 kr." for tiny negative rounding.
  return fmt.money.format(Math.abs(v) < 0.5 ? 0 : v);
}

/** +12 345 kr. / −12 345 kr. - for balances where the sign matters. */
export function signedMoney(v) {
  if (v == null) return '–';
  const s = money(Math.abs(v));
  if (Math.abs(v) < 0.5) return s;
  return (v > 0 ? '+' : '−') + s;
}

/** 12,3K kr. - for axis ticks and tight spots. */
export function moneyShort(v) {
  if (v == null) return '–';
  return fmt.moneyShort.format(v);
}

export function compact(v) {
  return fmt.compact.format(v);
}

/** 1.234,5 - for amounts in lists and inputs, no currency. */
export function amount(v) {
  if (v == null || v === '') return '';
  return fmt.plain.format(v);
}

export function percent(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return fmt.pct.format(v);
}

/**
 * Parse what someone typed into an amount box. Accepts the locale's own
 * format and the common alternatives (1.234,50 / 1,234.50 / 1234.5), and
 * simple sums like 120+45 for adding up receipts. Returns null for empty,
 * NaN for invalid.
 */
export function parseAmount(text) {
  if (text == null) return null;
  let s = String(text).trim().replace(/[\s  ']/g, '').replace(/[−–]/g, '-');
  if (s === '') return null;
  if (/^[-+]?[\d.,]+([-+][\d.,]+)+$/.test(s)) {
    const terms = s.match(/[-+]?[\d.,]+/g).map(parseAmount);
    return terms.some(Number.isNaN) ? NaN : Math.round(terms.reduce((a, b) => a + b, 0) * 100) / 100;
  }
  if (!/^[-+]?[\d.,]+$/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    // "1.234" in a comma-decimal locale (or "1,234" in a dot one) is thousands.
    const isThousands = count > 1 || (sep !== fmt.decimal && after === 3);
    s = isThousands ? s.split(sep).join('') : s.replace(sep, '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/** Short and long month names, January first. */
export function monthNames(style = 'short') {
  const f = new Intl.DateTimeFormat(fmt.locale, { month: style });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(2020, i, 15)).replace('.', ''));
}

export function sum(values) {
  let total = 0;
  for (const v of values) if (v != null) total += v;
  return Math.round(total * 100) / 100;
}
