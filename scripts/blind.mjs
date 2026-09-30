#!/usr/bin/env node
/**
 * Blind backward test runner — the deterministic half. Judging is done by the
 * `blind-judge` subagent, which has no tools and sees one case at a time.
 *
 *   node scripts/blind.mjs universe [--top 200]
 *       today's market-cap top N (common shares, KOSPI+KOSDAQ in one list)
 *   node scripts/blind.mjs register --run pilot --universe <file> --seed <int> --count 30
 *       [--from 20160104] [--to YYYYMMDD]   pre-register the candidates (once)
 *   node scripts/blind.mjs build --run pilot     fetch into PIT and write cases + seals
 *   node scripts/blind.mjs restore --run pilot [--model <id>]
 *       decisions/<case_id>.md (case units) → restored/<decision_id>.md (real prices)
 *   node scripts/blind.mjs status --run pilot
 *
 * Then score with the existing scorecard, by directory so blind and forward
 * judgments never mix: `node scripts/scorecard.mjs score <run>/restored --write`.
 * Runs live in the git-ignored `.claude/investments/blind/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { silenceSqliteWarning } from './lib/quiet-sqlite.mjs';

silenceSqliteWarning();
const { run } = await import('./lib/cluefin.mjs');
const { openPit, tradingCalendar } = await import('./pit/db.mjs');
const { createFetcher } = await import('./pit/fetch.mjs');
const { topByMarketCap } = await import('./blind/universe.mjs');
const { createRegistry, MIN_GAP_SESSIONS } = await import('./blind/sample.mjs');
const { buildCases, readManifest, restoreAll, runPaths, writeRegistry } = await import(
  './blind/pipeline.mjs'
);

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BLIND_ROOT = join(ROOT, '.claude/investments/blind');
const DEFAULT_DB = join(ROOT, '.claude/investments/pit/pit.sqlite');
const CALENDAR_START = '20151201';
const DEFAULT_FROM = '20160104';

const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--')) return { command, error: `알 수 없는 인자 ${rest[i]}` };
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

function openStore(flags) {
  const path = flags.db ? resolve(flags.db) : DEFAULT_DB;
  mkdirSync(dirname(path), { recursive: true });
  return openPit(path);
}

function universe(flags, { cli }) {
  const summaries = {};
  for (const [market, code] of [
    ['KOSPI', '0'],
    ['KOSDAQ', '10'],
  ]) {
    summaries[market] = cli(['kiwoom', 'stock', 'summary', '--market-type', code]).list ?? [];
  }
  const rows = topByMarketCap(summaries, Number(flags.top ?? 200));
  const out = {
    source: 'kiwoom stock summary (listCount × lastPrice)',
    price_basis: 'lastPrice는 조회 전일 종가',
    fetched_on: today(),
    rows,
  };
  const path = join(BLIND_ROOT, `universe-${out.fetched_on}.json`);
  mkdirSync(BLIND_ROOT, { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  return { path, count: rows.length, last: rows.at(-1) };
}

/**
 * The as_of range ends MIN_GAP_SESSIONS before the calendar's last session, so
 * every candidate can be scored to its longest horizon.
 */
function register(flags, { cli }) {
  const { run: name, seed, count } = flags;
  if (!name || !flags.universe || !/^\d+$/.test(seed ?? '') || !/^\d+$/.test(count ?? ''))
    return null;
  const db = openStore(flags);
  try {
    createFetcher(db, { cli }).index('0001', CALENDAR_START, today());
    const calendar = tradingCalendar(db);
    const to = flags.to ?? calendar[calendar.length - 1 - MIN_GAP_SESSIONS];
    const pool = JSON.parse(readFileSync(resolve(flags.universe), 'utf8'));
    const registry = createRegistry({
      name,
      universe: pool.rows.map(({ symbol, name: stockName, market }) => ({
        symbol,
        name: stockName,
        market,
      })),
      universeSource: `${flags.universe} (${pool.source}, ${pool.fetched_on})`,
      calendar,
      from: flags.from ?? DEFAULT_FROM,
      to,
      seed: Number(seed),
      count: Number(count),
      createdAt: new Date().toISOString(),
    });
    const paths = runPaths(BLIND_ROOT, name);
    writeRegistry(paths, registry);
    return {
      registry: paths.registry,
      candidates: registry.candidates.length,
      sha256: registry.candidates_sha256,
      as_of_range: registry.as_of_range,
    };
  } finally {
    db.close();
  }
}

function build(flags, { cli }) {
  if (!flags.run) return null;
  const paths = runPaths(BLIND_ROOT, flags.run);
  if (!existsSync(paths.registry)) throw new Error(`${paths.registry}가 없다 — register 먼저`);
  const db = openStore(flags);
  try {
    return buildCases(paths, {
      db,
      fetcher: createFetcher(db, { cli }),
      today: today(),
      log: (line) => console.error(line),
    });
  } finally {
    db.close();
  }
}

function status(flags) {
  if (!flags.run) return null;
  const paths = runPaths(BLIND_ROOT, flags.run);
  const entries = Object.entries(readManifest(paths).entries);
  const count = (status) => entries.filter(([, e]) => e.status === status).length;
  return {
    built: count('built'),
    excluded: count('excluded'),
    pending_judgment: entries
      .filter(([id, e]) => e.status === 'built' && !existsSync(join(paths.decisions, `${id}.md`)))
      .map(([id]) => id),
  };
}

const USAGE =
  'usage: node scripts/blind.mjs <universe|register|build|restore|status> [...] (파일 머리 주석 참고)';

export function main(argv, { cli = run } = {}) {
  const { command, flags, error } = parseArgs(argv);
  const commands = {
    universe: () => universe(flags, { cli }),
    register: () => register(flags, { cli }),
    build: () => build(flags, { cli }),
    restore: () =>
      flags.run
        ? restoreAll(runPaths(BLIND_ROOT, flags.run), { generatorModel: flags.model })
        : null,
    status: () => status(flags),
  };
  if (error || !commands[command]) {
    console.error(error ?? USAGE);
    return 2;
  }
  const result = commands[command]();
  if (result === null) {
    console.error(USAGE);
    return 2;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
