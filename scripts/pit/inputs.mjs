/**
 * PIT store → the normalized inputs `scripts/blind/case.mjs` builds a case from.
 * Every read goes through an as-of query, so nothing dated after `asOf` can
 * reach the builder. Blocks the store does not hold yet (financials,
 * disclosures, opinions until P4/P5) come back null, which the case reports as
 * "not loaded" rather than "none".
 */
import { PRICE_WINDOW } from '../blind/case.mjs';
import { flowsAsOf, indexAsOf, pricesAsOf, technicalAt } from './db.mjs';
import { TECHNICAL_CANDLES } from './fetch.mjs';

export function caseInputs(db, { symbol, asOf, benchmarkCode }) {
  const prices = pricesAsOf(db, symbol, asOf).slice(-PRICE_WINDOW);
  const from = prices[0]?.date ?? asOf;
  const flows = flowsAsOf(db, symbol, asOf, { from });
  return {
    prices,
    index: indexAsOf(db, benchmarkCode, asOf, { from }),
    technical: technicalAt(db, symbol, asOf, TECHNICAL_CANDLES),
    flows: flows.length > 0 ? flows : null,
    financials: null,
    disclosures: null,
    opinions: null,
  };
}
