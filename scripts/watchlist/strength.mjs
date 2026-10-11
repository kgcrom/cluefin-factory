/**
 * Strength against the stock's own market index — the watchlist's RS.
 *
 * An RS percentile ranks ~2,500 stocks, which would need every stock's prices.
 * The rule this replaces it with is the manuscript's own "종목 RS > 지수 RS": because a
 * percentile only ranks the weighted return, comparing the stock's weighted return with its
 * index's is the same comparison, and it needs two series instead of 2,500. In the
 * backtest it also did better than the percentile band (docs/watchlist-rules.md).
 *
 * KOSPI stocks are compared with 0001 and KOSDAQ stocks with 1001 — not KOSPI200, which is
 * what the scorecard benchmarks against.
 */
import { SECTOR } from '../lib/cluefin.mjs';
import { returnPct, weightedReturn } from './features.mjs';

/** The index a stock's strength is measured against. */
export function indexFor(market) {
  if (market === 'KOSPI') return SECTOR.KOSPI;
  if (market === 'KOSDAQ') return SECTOR.KOSDAQ;
  throw new Error(`시장을 알 수 없다: ${market}`);
}

/**
 * `rel`: stock weighted return ÷ index weighted return (1 = as strong as the index).
 * `ex21`: stock 21-session return − index 21-session return, in %p (stands in for RS(1M)).
 *
 * The index is read on the stock's last date; a missing date is a data error, not
 * something to paper over with the nearest day. Null when either series is too short.
 */
export function strength(candles, indexCloses) {
  const asOf = candles.at(-1)?.date;
  const at = indexCloses.findIndex((row) => row.date === asOf);
  if (at === -1) throw new Error(`지수에 ${asOf} 종가가 없다`);
  const stockCloses = candles.map((c) => c.close);
  const closes = indexCloses.slice(0, at + 1).map((row) => row.close);
  const stockRaw = weightedReturn(stockCloses);
  const indexRaw = weightedReturn(closes);
  if (stockRaw === null || indexRaw === null) return null;
  return {
    rel: stockRaw / indexRaw,
    ex21: returnPct(stockCloses, 21) - returnPct(closes, 21),
    indexRaw,
  };
}
