/**
 * The blind test's stock universe: common shares ranked by market cap across
 * KOSPI and KOSDAQ in one list (no per-market quota).
 *
 * The pilot ranks by **today's** cap from `kiwoom stock summary` — there is no
 * as-of ranking before the share-count command (PIT P3). That favours stocks
 * that are large now, so pilot results are read for pipeline and leakage
 * checks only, never for performance.
 */

export const BENCHMARK_BY_MARKET = { KOSPI: '2001', KOSDAQ: '1001' };

/**
 * Common shares only. KOSPI rows without a KRX size class (`upSizeName`) are
 * ETFs, ETNs and other products; a 6-digit code not ending in 0 is a preferred
 * share; SPACs are flagged by class or name.
 */
export function isCommonShare(row, market) {
  if (!/^\d{5}0$/.test(row.code ?? '')) return false;
  if (market === 'KOSPI') return Boolean(row.upSizeName);
  const spac =
    String(row.companyClassName ?? '').includes('스팩') || String(row.name).includes('스팩');
  return row.kind === 'A' && !spac;
}

/**
 * `summaries`: `{ KOSPI: rows, KOSDAQ: rows }` from `kiwoom stock summary`.
 * Cap = listed shares × `lastPrice` — the previous session's close (2026-09-30
 * check against `kis ranking market-cap`). Returns the top `n`, largest first.
 */
export function topByMarketCap(summaries, n = 200) {
  const rows = [];
  for (const market of ['KOSPI', 'KOSDAQ']) {
    for (const row of summaries[market] ?? []) {
      if (!isCommonShare(row, market)) continue;
      const shares = Number(row.listCount);
      const price = Number(row.lastPrice);
      if (!(shares > 0 && price > 0)) continue;
      rows.push({ symbol: row.code, name: row.name, market, market_cap: shares * price });
    }
  }
  return rows
    .sort((a, b) => b.market_cap - a.market_cap || a.symbol.localeCompare(b.symbol))
    .slice(0, n)
    .map((row, i) => ({ rank: i + 1, ...row }));
}
