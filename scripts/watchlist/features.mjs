/**
 * Price features of the last candle, exactly as the watchlist backtest computed them.
 *
 * A threshold in classify.mjs only means something against these formulas
 * (docs/watchlist-rules.md), so they are ports, not re-derivations. Two differ from
 * elsewhere in the repo on purpose:
 * - The 52-week high/low exclude the day itself and use intraday highs/lows of the 250
 *   sessions before it.
 * - ATR is the plain 14-day mean of true range, not atr.mjs's Wilder smoothing.
 *
 * Candles are `{ date, open, high, low, close, volume, value }`, oldest first, where
 * `value` is the day's traded value in won.
 */

/** 250 prior sessions for the 52-week range plus the day itself; also covers the 250-day return. */
export const MIN_CANDLES = 251;

const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), Number.NEGATIVE_INFINITY);
const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m), Number.POSITIVE_INFINITY);

/** Mean of the `n` values ending at index `t`. */
const sma = (values, t, n) => mean(values.slice(t - n + 1, t + 1));

/** max(high−low, |high−prevClose|, |low−prevClose|); the first candle has no previous close. */
export function trueRange(candles, i) {
  const { high, low } = candles[i];
  if (i === 0) return high - low;
  const prevClose = candles[i - 1].close;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/**
 * IBD-style weighted return: the last quarter counts twice. Comparing this number between
 * a stock and its market index is the same comparison as their RS percentiles, because the
 * percentile only ranks it.
 */
export function weightedReturn(closes, t = closes.length - 1) {
  if (t < 250) return null;
  const c = closes[t];
  return 2 * (c / closes[t - 63]) + c / closes[t - 126] + c / closes[t - 189] + c / closes[t - 250];
}

/** Return over `n` sessions in %, or null when the series is shorter. */
export function returnPct(closes, n, t = closes.length - 1) {
  return t < n ? null : (closes[t] / closes[t - n] - 1) * 100;
}

/** Features of the last candle, or null when there are fewer than MIN_CANDLES. */
export function features(candles) {
  if ((candles?.length ?? 0) < MIN_CANDLES) return null;
  const t = candles.length - 1;
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const volume = candles.map((c) => c.volume);
  const value = candles.map((c) => c.value);
  const c = close[t];

  const ma50 = sma(close, t, 50);
  const ma150 = sma(close, t, 150);
  const ma200 = sma(close, t, 200);
  const ma200Rising = ma200 > sma(close, t - 20, 200);
  const hi52 = maxOf(high.slice(t - 250, t));
  const lo52 = minOf(low.slice(t - 250, t));
  const gap52h = (c / hi52 - 1) * 100;
  const from52l = (c / lo52 - 1) * 100;
  // Minervini's trend template.
  const tt =
    c > ma150 &&
    c > ma200 &&
    ma150 > ma200 &&
    ma200Rising &&
    ma50 > ma150 &&
    c > ma50 &&
    from52l >= 25 &&
    gap52h >= -25;

  const high10 = maxOf(high.slice(t - 9));
  const high60 = maxOf(high.slice(t - 59));
  const atr14 = mean(Array.from({ length: 14 }, (_, k) => trueRange(candles, t - 13 + k)));

  return {
    date: candles[t].date,
    close: c,
    ma50,
    ma150,
    ma200,
    hi52,
    lo52,
    gap52h,
    from52l,
    tt,
    r21: returnPct(close, 21),
    rsRaw: weightedReturn(close),
    range10: ((high10 - minOf(low.slice(t - 9))) / high10) * 100,
    atr14p: (atr14 / c) * 100,
    v20to50: mean(volume.slice(t - 19)) / mean(volume.slice(t - 49)),
    tv20: mean(value.slice(t - 19)) / 1e8,
    distMa50: (c / ma50 - 1) * 100,
    depth60: (1 - minOf(low.slice(t - 59)) / high60) * 100,
  };
}
