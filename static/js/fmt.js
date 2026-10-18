// Number formatting and parsing in the household's locale and currency.

let fmt = null;

// Month names, the currency symbol and its placement follow the app's
// language; the decimal separator is a setting of its own (comma or dot), and
// the thousands separator is simply the other one.
const LANGUAGE_LOCALE = { da: 'da-DK', en: 'en-GB' };

export function defaultDecimal(language) {
  return language === 'en' ? '.' : ',';
}

export function setFormat({ language = 'en', currency = 'USD', decimal, both = 'last' } = {}) {
  const locale = LANGUAGE_LOCALE[language] || 'en-GB';
  // 'either': comma and dot both mean decimal, so numbers are shown with the
  // language's usual decimal sign and a thin space between thousands.
  const either = decimal === 'either';
  const dec = decimal === '.' || decimal === ',' ? decimal : defaultDecimal(language);
  const make = (options, fallback) => {
    try {
      return new Intl.NumberFormat(locale, options);
    } catch {
      return new Intl.NumberFormat(locale, fallback);
    }
  };
  fmt = {
    locale,
    either,
    both: both === 'invalid' ? 'invalid' : 'last', // 'either' with a comma and a dot: the last is the decimal sign, or invalid
    decimal: dec,
    group: either ? '\u202f' : dec === ',' ? '.' : ',',
    money: make({ style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }, { maximumFractionDigits: 0 }),
    moneyShort: make({ style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }, { notation: 'compact', maximumFractionDigits: 1 }),
    plain: make({ maximumFractionDigits: 2, minimumFractionDigits: 0 }),
    compact: make({ notation: 'compact', maximumFractionDigits: 1 }),
    pct: make({ style: 'percent', maximumFractionDigits: 0 }),
  };
}

/** Format with the chosen separators instead of the locale's own. */
function apply(nf, v) {
  return nf.formatToParts(v).map((p) => (p.type === 'decimal' ? fmt.decimal : p.type === 'group' ? fmt.group : p.value)).join('');
}

setFormat();

/** 12 345 kr. - for totals. Rounded to whole units. */
export function money(v) {
  if (v == null || Number.isNaN(v)) return '–';
  // Avoid "-0 kr." for tiny negative rounding.
  return apply(fmt.money, Math.abs(v) < 0.5 ? 0 : v);
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
  return apply(fmt.moneyShort, v);
}

export function compact(v) {
  return apply(fmt.compact, v);
}

/** 1.234,5 - for amounts in lists and inputs, no currency. */
export function amount(v) {
  if (v == null || v === '') return '';
  return apply(fmt.plain, v);
}

export function percent(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return apply(fmt.pct, v);
}

/**
 * Parse what someone typed into an amount box, using the decimal separator
 * from the settings. Anything else (thousands separators, spaces, "kr.") is
 * ignored. Simple sums like 120+45 add up receipts. Returns null for empty,
 * NaN for invalid.
 */
export function parseAmount(text) {
  if (text == null || String(text).trim() === '') return null;
  const keep = fmt.either ? /[^0-9,.+-]/g : fmt.decimal === ',' ? /[^0-9,+-]/g : /[^0-9.+-]/g;
  const s = String(text).replace(/[−–]/g, '-').replace(keep, '');
  const terms = s.match(/[+-]?[^+-]+/g);
  if (!terms) return NaN;
  let total = 0;
  for (const term of terms) {
    let value = term;
    let dec = fmt.decimal;
    if (fmt.either) {
      // Comma or dot is the decimal sign. With both, the last one is (and the
      // other is ignored), or the number is invalid, as the setting says.
      if (value.includes(',') && value.includes('.')) {
        if (fmt.both === 'invalid') return NaN;
        dec = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.';
        value = value.split(dec === ',' ? '.' : ',').join('');
      } else dec = value.includes(',') ? ',' : '.';
    }
    if (value.split(dec).length > 2 || !/\d/.test(value)) return NaN;
    total += Number(value.replace(dec, '.'));
  }
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : NaN;
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
