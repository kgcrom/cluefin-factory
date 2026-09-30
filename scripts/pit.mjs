#!/usr/bin/env node
/**
 * PIT store entrypoint.
 *
 *   node scripts/pit.mjs migrate [--db <path>]   create / upgrade the schema
 *   node scripts/pit.mjs rebuild [--db <path>]   reload facts from raw
 *   node scripts/pit.mjs stats   [--db <path>]   row counts per table
 *   node scripts/pit.mjs fill --symbol 005930 --as-of 20240628 --benchmark 2001
 *                        [--horizon 120] [--db <path>]
 *       fetch one blind case's prices, benchmark, flows and technical reading,
 *       then report how many rows each case block gets from the store
 *
 * The store lives in the git-ignored `.claude/investments/pit/pit.sqlite` by default.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an ExperimentalWarning on first load in Node 22. Filter that
// one warning before the store module is imported; everything else still shows.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  emit.call(process, warning, ...rest);
};

const { FACT_TABLES, openPit, rebuild } = await import('./pit/db.mjs');
const { createFetcher } = await import('./pit/fetch.mjs');
const { caseInputs } = await import('./pit/inputs.mjs');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_DB = resolve(ROOT, '.claude/investments/pit/pit.sqlite');
const COMMANDS = ['migrate', 'rebuild', 'stats', 'fill'];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--')) return { command, error: `알 수 없는 인자 ${rest[i]}` };
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags, db: flags.db ? resolve(flags.db) : DEFAULT_DB };
}

const USAGE =
  'usage: node scripts/pit.mjs <migrate|rebuild|stats> [--db <path>]\n' +
  '       node scripts/pit.mjs fill --symbol <6자리> --as-of <YYYYMMDD> --benchmark <0001|1001|2001> [--horizon 120]';

function stats(db, path) {
  const rows = Object.fromEntries(
    ['raw', ...FACT_TABLES].map((table) => [
      table,
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    ]),
  );
  const version = db.prepare('PRAGMA user_version').get().user_version;
  return { path, schema_version: version, rows };
}

function fill(db, flags, fetcherOptions) {
  const { symbol, benchmark } = flags;
  const asOf = flags['as-of'];
  if (
    !/^\d{6}$/.test(symbol ?? '') ||
    !/^\d{8}$/.test(asOf ?? '') ||
    !/^\d{4}$/.test(benchmark ?? '') ||
    !/^\d+$/.test(flags.horizon ?? '120')
  ) {
    return null;
  }
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const fetched = createFetcher(db, fetcherOptions).fillCase({
    symbol,
    asOf,
    benchmarkCode: benchmark,
    horizonDays: Number(flags.horizon ?? 120),
    today,
  });
  const inputs = caseInputs(db, { symbol, asOf, benchmarkCode: benchmark });
  return {
    fetched,
    case_inputs: {
      prices: inputs.prices.length,
      prices_last: inputs.prices.at(-1)?.date ?? null,
      index: inputs.index.length,
      flows: inputs.flows?.length ?? 0,
      technical: inputs.technical !== null,
    },
  };
}

/** `fetcherOptions` lets tests swap the CLI for a fake. */
export function main(argv, { fetcherOptions } = {}) {
  const { command, flags, db: path, error } = parseArgs(argv);
  if (error || !COMMANDS.includes(command)) {
    console.error(error ?? USAGE);
    return 2;
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = openPit(path);
  try {
    if (command === 'rebuild') console.log(JSON.stringify(rebuild(db)));
    if (command === 'stats' || command === 'migrate') console.log(JSON.stringify(stats(db, path)));
    if (command === 'fill') {
      const result = fill(db, flags, fetcherOptions);
      if (result === null) {
        console.error(USAGE);
        return 2;
      }
      console.log(JSON.stringify(result));
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
