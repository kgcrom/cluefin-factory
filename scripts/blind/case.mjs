/**
 * Blind case builder: turns point-in-time inputs for one (symbol, as_of) into a
 * case file the judgment runner can read without learning which stock or which
 * date it is, plus the seal that maps it back.
 *
 * Inputs are already normalized rows — the shapes below are what the PIT store
 * has to serve. Everything here is pure, so the same inputs always yield the
 * same case.
 *
 *   prices       [{ date, open, high, low, close, volume }]  adjusted, ascending
 *   index        [{ date, close }]
 *   technical    `kis chart technical --end-date <as_of>` output, as returned
 *   flows        [{ date, foreign_net_qty, institution_net_qty, short_qty }]
 *   financials   [{ known_at, bsns_year, period, metrics: { <FUNDAMENTAL_METRICS>: % } }]
 *   disclosures  [{ known_at, title }]
 *   opinions     [{ known_at, broker, opinion, prev_opinion, target_price }]
 *
 * Every date is compact `YYYYMMDD`. A row dated after `as_of` is a look-ahead
 * leak upstream, and the builder throws rather than dropping it quietly.
 */
import { createHash } from 'node:crypto';
import { FUNDAMENTAL_METRICS } from '../lib/fundamentals.mjs';
import { findLeaks, maskText } from './mask.mjs';

export const CASE_SCHEMA_VERSION = 1;
/** D-119 … D0: the window `technical-analysis` sees in a forward run. */
export const PRICE_WINDOW = 120;
const MIN_PRICE_ROWS = 60;
const VOLUME_BASE_DAYS = 20;
const HORIZONS = new Set([20, 60, 120]);
const BENCHMARK_NAME = { '0001': 'KOSPI', 1001: 'KOSDAQ', 2001: 'KOSPI200' };
const PERIODS = new Set(['Q1', 'H1', 'Q3', 'FY']);

/** Indicators quoted in price units — rebased like the candles. The rest are ratios. */
const PRICE_INDICATORS = ['sma_5', 'sma_20', 'sma_60', 'atr_14'];
const RATIO_INDICATORS = ['rsi_14', 'adx_14', 'mdd', 'sharpe'];

export class CaseError extends Error {}

const round2 = (value) => Math.round(value * 100) / 100;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function requireFinite(value, what) {
  if (!finite(value)) throw new CaseError(`${what}: 숫자가 아니다 (${value})`);
  return value;
}

/** Throws when any row is dated after `asOf` — PIT should never have served it. */
function assertNoFuture(rows, field, asOf, block) {
  const late = rows.find((row) => row[field] > asOf);
  if (late) throw new CaseError(`${block}: ${late[field]} 행이 as_of ${asOf} 이후다 (미래 누출)`);
}

/**
 * The relative trading-day index of `date` on the case's own calendar: D0 is
 * as_of, D-1 the trading day before. A non-trading date maps to the next
 * trading day — the earliest session that could have acted on it. Null when
 * the date falls before the window.
 */
export function relativeDay(tradingDates, date) {
  const at = tradingDates.findIndex((day) => day >= date);
  if (at === -1) return null;
  if (at === 0 && tradingDates[0] > date) return null;
  return at - (tradingDates.length - 1);
}

function priceBlock(prices, asOf) {
  assertNoFuture(prices, 'date', asOf, 'prices');
  if (prices.at(-1)?.date !== asOf) {
    throw new CaseError(`prices: 마지막 행 ${prices.at(-1)?.date}이 as_of ${asOf}가 아니다`);
  }
  const window = prices.slice(-PRICE_WINDOW);
  if (window.length < MIN_PRICE_ROWS) {
    throw new CaseError(`prices: ${window.length}행 — 최소 ${MIN_PRICE_ROWS}행이 필요하다`);
  }
  const reference = requireFinite(window.at(-1).close, 'prices D0 close');
  const baseVolume =
    window.slice(-VOLUME_BASE_DAYS).reduce((sum, row) => sum + row.volume, 0) / VOLUME_BASE_DAYS;
  const rebase = (value) => round2((value / reference) * 100);
  const rows = window.map((row, i) => ({
    d: i - (window.length - 1),
    open: rebase(requireFinite(row.open, `prices ${row.date} open`)),
    high: rebase(requireFinite(row.high, `prices ${row.date} high`)),
    low: rebase(requireFinite(row.low, `prices ${row.date} low`)),
    close: rebase(requireFinite(row.close, `prices ${row.date} close`)),
    volume_x: baseVolume > 0 ? round2(requireFinite(row.volume, 'volume') / baseVolume) : null,
  }));
  return { reference, rebase, dates: window.map((row) => row.date), rows };
}

function benchmarkBlock(index, benchmarkCode, dates, asOf) {
  assertNoFuture(index, 'date', asOf, 'index');
  const byDate = new Map(index.map((row) => [row.date, row.close]));
  const base = byDate.get(asOf);
  if (!finite(base)) throw new CaseError(`index: as_of ${asOf} 종가가 없다`);
  const series = dates
    .map((date, i) => ({ d: i - (dates.length - 1), close: byDate.get(date) }))
    .filter((row) => finite(row.close))
    .map((row) => ({ d: row.d, close: round2((row.close / base) * 100) }));
  return { name: BENCHMARK_NAME[benchmarkCode] ?? 'INDEX', series };
}

/**
 * `chart technical` output with prices rebased and the rest kept. Dropped:
 * `obv` (a cumulative share count gives away the stock's size), rule `reason`
 * strings (they quote raw prices), and the identifying header fields.
 */
export function technicalBlock(technical, asOf, reference, rebase) {
  if (!technical) return null;
  if (technical.as_of !== asOf) {
    throw new CaseError(`technical: as_of ${technical.as_of} ≠ 케이스 as_of ${asOf}`);
  }
  if (Math.abs(technical.close - reference) / reference > 0.001) {
    throw new CaseError(`technical: 종가 ${technical.close}가 가격 블록 D0 ${reference}와 다르다`);
  }
  const src = technical.indicators ?? {};
  const indicators = {};
  for (const key of PRICE_INDICATORS) if (finite(src[key])) indicators[key] = rebase(src[key]);
  for (const key of RATIO_INDICATORS) if (finite(src[key])) indicators[key] = src[key];
  if (src.macd) {
    // MACD is a difference of two price EMAs: price units, so it rebases too.
    indicators.macd = {
      macd: rebase(src.macd.macd),
      signal: rebase(src.macd.signal),
      histogram: rebase(src.macd.histogram),
    };
  }
  if (src.bbands_20) {
    indicators.bbands_20 = {
      upper: rebase(src.bbands_20.upper),
      middle: rebase(src.bbands_20.middle),
      lower: rebase(src.bbands_20.lower),
      percent_b: src.bbands_20.percent_b,
    };
  }
  if (src.stoch) indicators.stoch = { slow_k: src.stoch.slow_k, slow_d: src.stoch.slow_d };
  const family = (value) =>
    value && { label: value.label, score: value.score, evaluated_rules: value.evaluated_rules };
  return {
    indicators,
    signal: {
      trend: family(technical.signal?.trend),
      mean_reversion: family(technical.signal?.mean_reversion),
      rules: (technical.signal?.rules ?? []).map(({ name, family: f, vote }) => ({
        name,
        family: f,
        vote,
      })),
    },
  };
}

/** Net buying and short selling as % of the day's volume — size-free. */
function flowBlock(flows, prices, dates, asOf) {
  if (!flows) return null;
  assertNoFuture(flows, 'date', asOf, 'flows');
  const volume = new Map(prices.map((row) => [row.date, row.volume]));
  const pct = (qty, vol) => (finite(qty) && vol > 0 ? round2((qty / vol) * 100) : null);
  return flows
    .map((row) => ({ row, d: dates.includes(row.date) ? relativeDay(dates, row.date) : null }))
    .filter(({ d }) => d !== null)
    .map(({ row, d }) => {
      const vol = volume.get(row.date);
      return {
        d,
        foreign_net_pct: pct(row.foreign_net_qty, vol),
        institution_net_pct: pct(row.institution_net_qty, vol),
        short_pct: pct(row.short_qty, vol),
      };
    })
    .sort((a, b) => a.d - b.d);
}

/**
 * Ratios only, with the fiscal year replaced by its distance from the latest
 * report (`years_back`). The period kind stays: Q1/H1/Q3/FY is seasonal
 * context, not an identifier.
 */
function financialBlock(financials, dates, asOf) {
  if (!financials) return null;
  assertNoFuture(financials, 'known_at', asOf, 'financials');
  if (financials.length === 0) return [];
  const latestYear = Math.max(...financials.map((row) => Number(row.bsns_year)));
  return financials
    .map((row) => {
      if (!PERIODS.has(row.period)) throw new CaseError(`financials: period ${row.period}`);
      const metrics = {};
      for (const [name, value] of Object.entries(row.metrics ?? {})) {
        if (!(name in FUNDAMENTAL_METRICS)) throw new CaseError(`financials: 지표 ${name}`);
        if (finite(value)) metrics[name] = value;
      }
      return {
        known_d: relativeDay(dates, row.known_at),
        years_back: latestYear - Number(row.bsns_year),
        period: row.period,
        metrics,
      };
    })
    .sort((a, b) => a.years_back - b.years_back || a.period.localeCompare(b.period));
}

function disclosureBlock(disclosures, dates, asOf, names) {
  if (!disclosures) return null;
  assertNoFuture(disclosures, 'known_at', asOf, 'disclosures');
  return disclosures
    .map((row) => ({ d: relativeDay(dates, row.known_at), title: maskText(row.title, { names }) }))
    .filter((row) => row.d !== null)
    .sort((a, b) => a.d - b.d);
}

/**
 * Broker names become letters in order of first appearance, so revisions by the
 * same house stay linked. Target prices become upside vs. that day's close —
 * never vs. today's price, which the raw KIS response also carries.
 */
function opinionBlock(opinions, prices, dates, asOf) {
  if (!opinions) return null;
  assertNoFuture(opinions, 'known_at', asOf, 'opinions');
  const closeOn = (d) => prices.at(d - 1)?.close;
  const aliases = new Map();
  return opinions
    .map((row) => ({ row, d: relativeDay(dates, row.known_at) }))
    .filter(({ d }) => d !== null)
    .sort((a, b) => a.d - b.d)
    .map(({ row, d }) => {
      if (!aliases.has(row.broker)) aliases.set(row.broker, String.fromCharCode(65 + aliases.size));
      const close = closeOn(d);
      return {
        d,
        broker: aliases.get(row.broker),
        opinion: row.opinion ?? null,
        prev_opinion: row.prev_opinion ?? null,
        target_upside_pct:
          finite(row.target_price) && row.target_price > 0 && close > 0
            ? round2((row.target_price / close - 1) * 100)
            : null,
      };
    });
}

/** Stable JSON: keys sorted at every level, so the hash does not depend on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Case ids are letters only, so a digit run in one can never trip the leak scan. */
export const CASE_ID = /^[a-z]{12}$/;

/** A case id from 12 values in [0, 1) — `Math.random` for real runs, a seeded PRNG in B2. */
export function caseIdFrom(random = Math.random) {
  return Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join(
    '',
  );
}

/**
 * Build `{ case, seal }` for one (symbol, as_of).
 *
 * `meta`: { caseId, symbol, names, market, asOf, horizonDays, benchmarkCode, sources }
 * `inputs`: the normalized rows described at the top of the file. `prices` and
 * `index` are required; the other blocks are null when not loaded, and the
 * case says so rather than implying the stock had no disclosures.
 */
export function buildCase(meta, inputs) {
  const { caseId, symbol, names = [], market, asOf, horizonDays, benchmarkCode } = meta;
  if (!CASE_ID.test(caseId ?? '')) throw new CaseError(`case_id ${caseId}: 소문자 12자여야 한다`);
  if (!HORIZONS.has(horizonDays)) throw new CaseError(`horizon ${horizonDays}: 20/60/120만 쓴다`);
  if (market !== 'KOSPI' && market !== 'KOSDAQ') throw new CaseError(`market ${market}`);

  const price = priceBlock(inputs.prices ?? [], asOf);
  const window = inputs.prices.slice(-price.dates.length);
  const blindCase = {
    schema_version: CASE_SCHEMA_VERSION,
    case_id: caseId,
    market,
    horizon_days: horizonDays,
    horizon_basis: 'trading',
    price_unit: 'D0 종가 = 100',
    prices: price.rows,
    benchmark: benchmarkBlock(inputs.index ?? [], benchmarkCode, price.dates, asOf),
    technical: technicalBlock(inputs.technical, asOf, price.reference, price.rebase),
    flows: flowBlock(inputs.flows, window, price.dates, asOf),
    financials: financialBlock(inputs.financials, price.dates, asOf),
    disclosures: disclosureBlock(inputs.disclosures, price.dates, asOf, names),
    opinions: opinionBlock(inputs.opinions, window, price.dates, asOf),
  };

  const leaks = findLeaks(blindCase, { symbol, names });
  if (leaks.length > 0) {
    const detail = leaks.map((leak) => `${leak.path}: ${leak.reason}`).join('; ');
    throw new CaseError(`마스킹 후에도 식별자가 남았다 — ${detail}`);
  }

  const seal = {
    schema_version: CASE_SCHEMA_VERSION,
    case_id: caseId,
    symbol,
    name: names[0] ?? symbol,
    market,
    as_of: asOf,
    reference_price: price.reference,
    benchmark_code: benchmarkCode,
    horizon_days: horizonDays,
    case_sha256: sha256(canonicalJson(blindCase)),
    sources: meta.sources ?? [],
  };
  return { case: blindCase, seal };
}

/** The hash a blind decision carries to prove which seal it was restored with. */
export const sealHash = (seal) => sha256(canonicalJson(seal));
