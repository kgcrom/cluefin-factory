/**
 * ATR14 from daily candles.
 *
 * The CLI has no as-of ATR endpoint — `kis chart technical` reads indicators at
 * *today*, and a judgment's stop width has to be checked against the volatility
 * that existed on its own `data_as_of.price`. So it is computed here from the
 * candles the scorecard already knows how to fetch.
 *
 * Wilder smoothing, the same definition `final-decision` writes stops against:
 * seed with the mean of the first `period` true ranges, then roll.
 */
import { toUtc } from './scoring.mjs';

const DAY_MS = 86_400_000;
export const ATR_PERIOD = 14;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** max(high−low, |high−prevClose|, |low−prevClose|) for each candle after the first. */
export function trueRanges(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i += 1) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    if (!finite(high) || !finite(low) || !finite(prevClose)) return null;
    out.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return out;
}

/** ATR over the whole series, or null when the candles are short or malformed. */
export function atr14(candles, period = ATR_PERIOD) {
  const ranges = trueRanges(candles ?? []);
  if (ranges === null || ranges.length < period) return null;
  let value = ranges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  for (const tr of ranges.slice(period)) value = (value * (period - 1) + tr) / period;
  return value;
}

/** The compact date `days` calendar days before `end` — where an ATR window starts. */
export function lookbackStart(end, days) {
  return new Date(toUtc(end) - days * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '');
}
