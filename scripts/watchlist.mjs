#!/usr/bin/env node
/**
 * Watchlist group check — is a stock in group 1, 2 or 3, and is it one to set an alert on.
 *
 *   node scripts/watchlist.mjs check --symbol 033780 [--as-of YYYYMMDD]
 *   node scripts/watchlist.mjs check --name KT&G
 *
 * Prints one JSON object. The rules are in scripts/watchlist/classify.mjs and their
 * evidence in docs/watchlist-rules.md.
 *
 * Run during market hours, today's candle is still forming, so the check is made on the
 * previous session's close. The KIS/Kiwoom listing is cached once a day in the
 * git-ignored `.claude/investments/watchlist/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookbackStart } from './lib/atr.mjs';
import { CluefinError, dailyCandles, run, sectorDailyRange } from './lib/cluefin.mjs';
import { classify } from './watchlist/classify.mjs';
import { features, MIN_CANDLES } from './watchlist/features.mjs';
import { pivot } from './watchlist/pivot.mjs';
import { buildListing, resolveStock } from './watchlist/resolve.mjs';
import { indexFor, strength } from './watchlist/strength.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_DIR = join(ROOT, '.claude/investments/watchlist');
/** Calendar days fetched before as-of: comfortably more than MIN_CANDLES sessions. */
const LOOKBACK_DAYS = 420;
/** 15:30 close plus the closing auction settling; before this today's candle is partial. */
const SETTLED_MINUTES = 15 * 60 + 40;

/** Today's date and minutes past midnight in KST. */
export function kstClock(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return {
    date: kst.toISOString().slice(0, 10).replaceAll('-', ''),
    minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
  };
}

/** Today's listing of common shares, fetched once a day. */
export function loadListing({ cli, today, cacheDir = CACHE_DIR }) {
  const path = join(cacheDir, `listing-${today}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const summaries = {};
  for (const [market, code] of [
    ['KOSPI', '0'],
    ['KOSDAQ', '10'],
  ]) {
    summaries[market] = cli(['kiwoom', 'stock', 'summary', '--market-type', code]).list ?? [];
  }
  const listing = buildListing(summaries);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(listing)}\n`);
  return listing;
}

/** Numbers rounded to 2 decimals for reading; decisions were made on the unrounded ones. */
function present(value) {
  if (typeof value === 'number')
    return Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(present);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, present(v)]));
  }
  return value;
}

const NOTES = [
  '규칙은 2025-02~2026-10 강세장 위주 백테스트에서 나왔다(상장폐지 종목 없음).',
  '매수 당일에는 거래량(50일 평균의 1.5배 이상)과 같은 업종의 동반 상승을 따로 확인한다.',
];

const FLAGS = new Set(['symbol', 'name', 'as-of']);

/** The `check` command. Null on a usage error. */
export function check(flags, { cli = run, now = new Date(), cacheDir } = {}) {
  if (Object.keys(flags).some((key) => !FLAGS.has(key))) return null;
  const { symbol, name } = flags;
  const asOfFlag = flags['as-of'];
  if (Boolean(symbol) === Boolean(name)) return null;
  if (symbol && !/^\d{6}$/.test(symbol)) return null;
  if (asOfFlag && !/^\d{8}$/.test(asOfFlag)) return null;

  const clock = kstClock(now);
  const stock = resolveStock(loadListing({ cli, today: clock.date, cacheDir }), { symbol, name });
  const asOf = asOfFlag ?? clock.date;
  const from = lookbackStart(asOf, LOOKBACK_DAYS);
  const candles = dailyCandles(stock.symbol, from, asOf, { cli });
  if (candles.at(-1)?.date === clock.date && clock.minutes < SETTLED_MINUTES) candles.pop();

  const benchmark = indexFor(stock.market);
  const head = {
    ...stock,
    benchmark,
    asOf: candles.at(-1)?.date ?? null,
    candleCount: candles.length,
  };
  const f = features(candles);
  if (f === null) {
    return {
      ...head,
      action: 'exclude',
      status: 'insufficient_history',
      reason: `일봉이 ${MIN_CANDLES}개 미만 — 52주·이동평균을 잴 수 없다`,
    };
  }
  const s = strength(candles, sectorDailyRange(benchmark, from, asOf, { cli }));
  if (s === null) throw new Error(`지수 ${benchmark} 종가가 ${MIN_CANDLES}개 미만`);
  const result = classify(f, pivot(candles), s);
  const { checks, ...decision } = result;
  return present({
    ...head,
    ...decision,
    strength: { rel: s.rel, ex21: s.ex21 },
    features: {
      close: f.close,
      gap52h: f.gap52h,
      from52l: f.from52l,
      tt: f.tt,
      range10: f.range10,
      atr14p: f.atr14p,
      tv20: f.tv20,
      distMa50: f.distMa50,
      depth60: f.depth60,
    },
    checks,
    notes: NOTES,
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) {
      return { command, error: `알 수 없는 인자 ${rest[i]}` };
    }
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

const USAGE =
  'usage: node scripts/watchlist.mjs check (--symbol <6자리> | --name <종목명>) [--as-of YYYYMMDD]';

export async function main(argv, deps = {}) {
  const { command, flags, error } = parseArgs(argv);
  if (error || command !== 'check') {
    console.error(error ?? USAGE);
    return 2;
  }
  let result;
  try {
    result = check(flags, deps);
  } catch (cause) {
    const code = cause instanceof CluefinError ? cause.code : 1;
    console.error(JSON.stringify({ error: { message: cause.message, exit_code: code } }));
    return code;
  }
  if (result === null) {
    console.error(USAGE);
    return 2;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
