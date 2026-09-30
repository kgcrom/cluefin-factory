/**
 * Vendor string → typed value, in one place. DART, KIS and Kiwoom all send
 * numbers as strings with their own conventions; every loader goes through
 * these so a rule is written (and tested) once.
 *
 * "No value" is null, never 0: DART's `-`, an empty string, and the `#########`
 * an overflowing spreadsheet cell leaves behind all mean the figure is missing.
 */

export class ConvertError extends Error {}

const MISSING = (text) => text === '' || text === '-' || /^#+$/.test(text);

function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replaceAll(',', '');
  return MISSING(text) ? null : text;
}

/**
 * Won amounts, share counts, volumes. `"5,969,782,550"` → 5969782550.
 * KIS sometimes writes integers as `"81500.0"`; a non-zero fraction is an error.
 * Throws beyond 2⁵³ — a silently rounded amount is worse than a failed load.
 */
export function toInt(value) {
  const text = clean(value);
  if (text === null) return null;
  const match = text.match(/^([+-]?\d+)(?:\.0+)?$/);
  if (!match) throw new ConvertError(`정수가 아니다: ${value}`);
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) throw new ConvertError(`안전 정수 범위 밖: ${value}`);
  return number;
}

/** Ratios, index levels, EPS — anything with a fraction. */
export function toReal(value) {
  const text = clean(value);
  if (text === null) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) throw new ConvertError(`숫자가 아니다: ${value}`);
  return Number(text);
}

/**
 * Kiwoom prefixes a price with its direction vs. the previous close:
 * `"-81500"` is a close of 81,500 on a down day, not a negative price.
 */
export function unsignedPrice(value) {
  const number = toInt(value);
  return number === null ? null : Math.abs(number);
}

/** `YYYYMMDD`, validated. DART, KIS and Kiwoom all use this form. */
export function compactDate(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(text)) {
    throw new ConvertError(`YYYYMMDD 날짜가 아니다: ${value}`);
  }
  return text;
}
