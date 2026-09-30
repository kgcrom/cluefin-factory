/**
 * Pre-registered sampling for blind cases.
 *
 * The draw is fixed by the seed before any case is built or judged: a list of
 * `count × oversample` candidates, in order, hashed into the registry. A
 * candidate that cannot become a case (too little price history, a suspended
 * day) is excluded with its reason, and the next one in the list takes its
 * place — the rule is "the first `count` that build", so nobody picks which
 * candidates count after seeing them.
 */
import { canonicalJson, caseIdFrom, sha256 } from './case.mjs';
import { BENCHMARK_BY_MARKET } from './universe.mjs';

export const HORIZONS = [20, 60, 120];
/** Same-stock as_of dates at least this many sessions apart: the longest horizon. */
export const MIN_GAP_SESSIONS = 120;
const OVERSAMPLE = 3;
const MAX_ATTEMPTS_PER_PICK = 1000;

/** mulberry32: small, seedable, and the same in every Node version. */
export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `universe`: [{ symbol, name, market }]. `calendar`: ascending trading days;
 * as_of is drawn from it between `from` and `to` inclusive, so every as_of is a
 * session. Returns `count × oversample` candidates.
 */
export function drawCandidates({
  universe,
  calendar,
  from,
  to,
  seed,
  count,
  oversample = OVERSAMPLE,
}) {
  const days = calendar.filter((day) => day >= from && day <= to);
  if (days.length === 0) throw new Error(`달력에 ${from}~${to} 거래일이 없다`);
  if (universe.length === 0) throw new Error('유니버스가 비었다');
  const random = prng(seed);
  const pick = (n) => Math.floor(random() * n);
  const taken = new Map(); // symbol → [day index]
  const usedIds = new Set();
  const candidates = [];
  const total = count * oversample;

  while (candidates.length < total) {
    let placed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PICK && !placed; attempt += 1) {
      const stock = universe[pick(universe.length)];
      const at = pick(days.length);
      const horizon = HORIZONS[pick(HORIZONS.length)];
      const caseId = caseIdFrom(random);
      const prior = taken.get(stock.symbol) ?? [];
      if (prior.some((other) => Math.abs(other - at) < MIN_GAP_SESSIONS)) continue;
      if (usedIds.has(caseId)) continue;
      taken.set(stock.symbol, [...prior, at]);
      usedIds.add(caseId);
      candidates.push({
        order: candidates.length + 1,
        case_id: caseId,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        as_of: days[at],
        horizon_days: horizon,
        benchmark_code: BENCHMARK_BY_MARKET[stock.market],
      });
      placed = true;
    }
    if (!placed)
      throw new Error('간격 규칙을 지키는 후보를 더 뽑을 수 없다 — 범위나 유니버스를 넓혀라');
  }
  return candidates;
}

/**
 * The registry written before any case exists. `candidates_sha256` covers the
 * ordered list; `universe_sha256` the pool it was drawn from.
 */
export function createRegistry({
  name,
  universe,
  universeSource,
  calendar,
  from,
  to,
  seed,
  count,
  createdAt,
}) {
  const candidates = drawCandidates({ universe, calendar, from, to, seed, count });
  return {
    schema_version: 1,
    name,
    created_at: createdAt,
    seed,
    count,
    rule: `후보를 order 순으로 케이스화하고, 만들어지는 첫 ${count}건을 표본으로 한다. 실패한 후보는 사유와 함께 excluded로 남긴다.`,
    as_of_range: { from, to },
    horizons: HORIZONS,
    min_gap_sessions: MIN_GAP_SESSIONS,
    universe_source: universeSource,
    universe_sha256: sha256(canonicalJson(universe)),
    candidates,
    candidates_sha256: sha256(canonicalJson(candidates)),
  };
}

/** Throws when a registry was edited after it was written. */
export function verifyRegistry(registry) {
  if (sha256(canonicalJson(registry.candidates)) !== registry.candidates_sha256) {
    throw new Error(`registry ${registry.name}: 후보 목록이 해시와 다르다 — 사후 수정`);
  }
  return registry;
}
