/**
 * The breakout pivot and the contractions of the base in front of it.
 *
 * The pivot is the most recent fractal high: a high above the FRACTAL_N sessions on its
 * left and not below the FRACTAL_N on its right — not "the highest high of the last N
 * days". A fractal needs FRACTAL_N sessions after it, so the last FRACTAL_N candles can
 * never hold the pivot — nothing here looks past the last candle.
 */

export const FRACTAL_N = 3;
/** Contractions are counted from the highest high of this many sessions. */
export const BASE_WINDOW = 60;

const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m), Number.POSITIVE_INFINITY);

/** Indices of confirmed fractal highs, oldest first. */
export function fractalHighs(highs, n = FRACTAL_N) {
  const out = [];
  for (let i = n; i < highs.length - n; i += 1) {
    let isHigh = true;
    for (let k = 1; k <= n && isHigh; k += 1) {
      if (highs[i - k] >= highs[i] || highs[i + k] > highs[i]) isHigh = false;
    }
    if (isHigh) out.push(i);
  }
  return out;
}

/** Drop from the high at `a` to the lowest low strictly after it and before `b`, in %. */
const depth = (highs, lows, a, b) => (1 - minOf(lows.slice(a + 1, b)) / highs[a]) * 100;

/**
 * Pivot of the last candle, or null when no fractal high is confirmed yet.
 *
 * - `lastContraction`: drop from the pivot to the lowest low after it (the pivot candle's
 *   own low is excluded).
 * - `legs`: depth of each contraction since the highest high of the last BASE_WINDOW
 *   sessions, one per swing high; `contractions` is their count.
 */
export function pivot(candles, { n = FRACTAL_N, baseWindow = BASE_WINDOW } = {}) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const t = candles.length - 1;
  const known = fractalHighs(highs, n);
  if (known.length === 0) return null;
  const p = known.at(-1);

  const from = Math.max(0, t + 1 - baseWindow);
  let start = from;
  for (let i = from + 1; i <= t; i += 1) if (highs[i] > highs[start]) start = i;
  const swings = [start, ...known.filter((i) => i > start)];
  const legs = [];
  swings.forEach((a, k) => {
    const b = swings[k + 1] ?? t + 1;
    if (b > a + 1) legs.push(depth(highs, lows, a, b));
  });

  return {
    price: highs[p],
    date: candles[p].date,
    age: t - p,
    lastContraction: depth(highs, lows, p, t + 1),
    legs,
    contractions: legs.length,
  };
}
