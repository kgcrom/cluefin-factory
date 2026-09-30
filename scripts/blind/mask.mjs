/**
 * Masking for blind cases: strip what lets a model recall the stock or the date.
 *
 * Text masking is string substitution, so it can only remove what it is told
 * about (company names) or what has a fixed shape (codes, years, fiscal-period
 * numbers). `findLeaks` is the backstop — the case builder runs it over the
 * finished case and refuses to write one that still carries an identifier.
 */

const COMPANY = '[회사]';

/** `2024`, `1999` — a year on its own, not part of a longer number. */
const YEAR = /(?<!\d)(?:19|20)\d{2}(?!\d)/g;
/** A 6-digit stock code or an 8-digit compact date. */
const CODE = /(?<!\d)\d{6}(?!\d)/g;
const COMPACT_DATE = /(?<!\d)(?:19|20)\d{6}(?!\d)/g;
/** `제56기` — the fiscal-period count gives away the company's age. */
const FISCAL_PERIOD = /제\s*\d+\s*기/g;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Mask a disclosure title (or any free text) for a blind case.
 * `names` are the company's names and aliases; longer ones are replaced first
 * so `삼성전자우` does not leave a stray `우` behind `삼성전자`.
 */
export function maskText(text, { names = [] } = {}) {
  let out = String(text);
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of sorted) out = out.replace(new RegExp(escapeRegExp(name), 'g'), COMPANY);
  return out
    .replace(COMPACT_DATE, '[날짜]')
    .replace(CODE, '[코드]')
    .replace(YEAR, '[연도]')
    .replace(FISCAL_PERIOD, '제[N]기');
}

/** Integers that read as a compact date (`20240628`). */
const looksLikeDate = (value) => Number.isInteger(value) && value >= 19000101 && value <= 20991231;

/**
 * Every place in `value` that still identifies the stock or the date: a name,
 * the stock code, a year or a compact date in a string, or a date-shaped number.
 * Returns `[{ path, reason }]`, empty when the case is clean.
 */
export function findLeaks(value, { symbol, names = [] } = {}) {
  const leaks = [];
  const needles = [symbol, ...names].filter(Boolean);
  const visit = (node, path) => {
    if (typeof node === 'string') {
      for (const needle of needles) {
        if (node.includes(needle)) leaks.push({ path, reason: `식별자 "${needle}"` });
      }
      if (node.match(YEAR)) leaks.push({ path, reason: `연도 "${node.match(YEAR)[0]}"` });
      if (node.match(CODE)) leaks.push({ path, reason: `숫자 코드 "${node.match(CODE)[0]}"` });
    } else if (typeof node === 'number') {
      if (looksLikeDate(node)) leaks.push({ path, reason: `날짜 모양 숫자 ${node}` });
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
    } else if (node && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        visit(key, `${path}.${key}(key)`);
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(value, '$');
  return leaks;
}
