// Number formatting and parsing in the household's locale and currency.

let fmt = null;

// Month names, the currency symbol and its placement follow the app's
// language; the decimal separator is a setting of its own (comma or dot), and
// the thousands separator is simply the other one.
const LANGUAGE_LOCALE = { da: 'da-DK', en: 'en-GB' };

export function defaultDecimal(language) {
  return language === 'en' ? '.' : ',';
}

export function setFormat({ language = 'en', currency = 'USD', decimal, both = 'last', decimals = 'keep' } = {}) {
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
    decimals, // keep | nearest | up | down | only (whole numbers only)
    group: either ? '\u202f' : dec === ',' ? '.' : ',',
    // narrowSymbol: "$" rather than "US$", "kr." for kroner.
    money: make({ style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0, minimumFractionDigits: 0 }, { maximumFractionDigits: 0 }),
    moneyShort: make({ style: 'currency', currency, currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 }, { notation: 'compact', maximumFractionDigits: 1 }),
    plain: make({ maximumFractionDigits: 2, minimumFractionDigits: 0 }),
    compact: make({ notation: 'compact', maximumFractionDigits: 1 }),
    pct: make({ style: 'percent', maximumFractionDigits: 0 }),
  };
}

// A real minus sign, joined to the number so a line never breaks between them.
const MINUS = '−\u2060';

/** Format with the chosen separators instead of the locale's own. */
function apply(nf, v) {
  return nf.formatToParts(v).map((p) => (p.type === 'decimal' ? fmt.decimal : p.type === 'group' ? fmt.group : p.type === 'minusSign' ? MINUS : p.value)).join('');
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
  return (v > 0 ? '+' : MINUS) + s;
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

/**
 * Expenses are kept as positive amounts (a refund is negative) but shown as
 * negative numbers everywhere: this is the amount as it is shown.
 */
export function signed(v, kind) {
  return v == null || kind !== 'expense' ? v : -v;
}

/** An amount as it stands in an amount box: an expense with its minus, money back on an expense with a plus. */
export function amountText(v, kind) {
  if (v == null || v === '') return '';
  if (kind !== 'expense' || Math.abs(v) < 0.005) return amount(v);
  return (v > 0 ? MINUS : '+') + amount(Math.abs(v));
}

/** True for a negative amount typed as income, which isn't allowed: it would be an expense. */
export function negativeIncome(text, kind) {
  const v = kind === 'income' ? parseAmount(text) : null;
  return v != null && v < 0;
}

/**
 * What was typed in an amount box, as it is kept. In an expense box a number
 * without a sign is money spent, as is one with a minus; a plus is money back.
 * Income can't be negative (NaN).
 */
export function parseTyped(text, kind) {
  const v = parseAmount(text);
  if (negativeIncome(text, kind)) return NaN;
  if (kind !== 'expense' || v == null || Number.isNaN(v)) return v;
  return /^\s*[-−–+]/.test(String(text)) ? -v || 0 : v;
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
  text = text == null ? text : String(text).replace(/\u2060/g, '');
  if (text == null || text.trim() === '') return null;
  if (fmt.decimals === 'only') {
    // Digits only, with a sign in front; the thousands separators amounts are shown with ("−2.160") are fine.
    const t = String(text).trim();
    const sign = /^[-−–+]/.test(t) ? t[0] : '';
    const s = t.slice(sign.length).trim();
    const grouped = new RegExp(`^[0-9]{1,3}(${fmt.group === '\u202f' ? '[\u202f ]' : '\\' + fmt.group}[0-9]{3})+$`);
    if (!/^[0-9]+$/.test(s) && !grouped.test(s)) return NaN;
    const v = Number(s.replace(/[^0-9]/g, ''));
    return sign && sign !== '+' ? -v || 0 : v;
  }
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
  return Number.isFinite(total) ? roundWhole(Math.round(total * 100) / 100) : NaN;
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

// ------------------------------------------------------------------ decimals

/** v in whole units as the settings say (up and down: away from and towards zero). */
export function roundWhole(v) {
  const mode = fmt.decimals;
  if (v == null || !['nearest', 'up', 'down'].includes(mode)) return v;
  const cents = Math.abs(Math.round(v * 100));
  let whole = Math.floor(cents / 100);
  const rest = cents % 100;
  if (rest && (mode === 'up' || (mode === 'nearest' && rest >= 50))) whole += 1;
  return (v < 0 ? -1 : 1) * whole;
}

/** True when only whole numbers may be typed. */
export function wholeOnly() {
  return fmt.decimals === 'only';
}

/** An amount with decimals in a budget set to whole numbers: shown as a problem. */
export function hasDecimals(v) {
  return fmt.decimals !== 'keep' && v != null && Math.round(v * 100) % 100 !== 0;
}

/** For an amount box's onInput: with whole numbers only, nothing but 0-9 (and a sign in front) gets in. */
export function cleanTyped(e) {
  if (wholeOnly()) {
    const sign = e.target.value.match(/^\s*([-−–+])/)?.[1] || '';
    const clean = sign + e.target.value.replace(/[^0-9]/g, '');
    if (clean !== e.target.value) e.target.value = clean;
  }
  return e.target.value;
}

export function amountInputMode() {
  return wholeOnly() ? 'numeric' : 'decimal';
}
