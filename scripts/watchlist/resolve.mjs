/**
 * Stock name or code → the listed common share and its market.
 *
 * The market decides which index the stock is measured against (strength.mjs), so a
 * name that matches more than one stock is an error, never a guess.
 */
import { isCommonShare } from '../blind/universe.mjs';

/** Common shares from `kiwoom stock summary` (`{ KOSPI: rows, KOSDAQ: rows }`). */
export function buildListing(summaries) {
  return Object.entries(summaries).flatMap(([market, rows]) =>
    rows
      .filter((row) => isCommonShare(row, market))
      .map((row) => ({ symbol: row.code, name: row.name, market, sector: row.upName ?? null })),
  );
}

const normalize = (text) => String(text).replace(/\s+/g, '').toLowerCase();

/**
 * `symbol` matches the 6-digit code exactly. `name` tries an exact name, then the name
 * ignoring spaces and case, then a unique partial match; several partial matches throw
 * with the candidates so the caller can ask which one was meant.
 */
export function resolveStock(listing, { symbol, name }) {
  if (symbol) {
    const row = listing.find((r) => r.symbol === symbol);
    if (!row) throw new Error(`보통주 목록에 ${symbol} 없음 (우선주·ETF·스팩은 대상이 아니다)`);
    return row;
  }
  const wanted = normalize(name ?? '');
  if (!wanted) throw new Error('종목명이 비었다');
  const exact = listing.filter((r) => r.name === name);
  if (exact.length === 1) return exact[0];
  const loose = listing.filter((r) => normalize(r.name) === wanted);
  if (loose.length === 1) return loose[0];
  const partial = listing.filter((r) => normalize(r.name).includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0 && loose.length === 0) throw new Error(`'${name}'에 맞는 종목이 없다`);
  const candidates = (loose.length > 1 ? loose : partial)
    .slice(0, 10)
    .map((r) => `${r.name}(${r.symbol})`);
  throw new Error(`'${name}'에 여러 종목이 맞는다: ${candidates.join(', ')}`);
}
