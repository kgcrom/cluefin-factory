/**
 * The "known at" rule. DART's `rcept_dt` has a date but no time, so a filing is
 * treated as known from the next trading day on. That delays an intraday filing
 * by a day; it never lets a filing act before it existed.
 */

/**
 * The first trading day strictly after `date`, on an ascending calendar.
 * Null when the calendar cannot answer — `date` is outside it, or on/after its
 * last day, where the next session is not yet known.
 */
export function nextTradingDay(calendar, date) {
  if (calendar.length === 0 || date < calendar[0]) return null;
  let lo = 0;
  let hi = calendar.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calendar[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo < calendar.length ? calendar[lo] : null;
}
