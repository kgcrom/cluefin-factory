#!/usr/bin/env node
/**
 * PIT store entrypoint.
 *
 *   node scripts/pit.mjs migrate [--db <path>]   create / upgrade the schema
 *   node scripts/pit.mjs rebuild [--db <path>]   reload facts from raw
 *   node scripts/pit.mjs stats   [--db <path>]   row counts per table
 *
 * Fetching (P2) is not here yet. The store lives in the git-ignored
 * `.claude/investments/pit/pit.sqlite` by default.
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

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_DB = resolve(ROOT, '.claude/investments/pit/pit.sqlite');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const at = rest.indexOf('--db');
  return { command, db: at === -1 ? DEFAULT_DB : resolve(rest[at + 1]) };
}

const USAGE = 'usage: node scripts/pit.mjs <migrate|rebuild|stats> [--db <path>]';

export function main(argv) {
  const { command, db: path } = parseArgs(argv);
  if (!['migrate', 'rebuild', 'stats'].includes(command)) {
    console.error(USAGE);
    return 2;
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = openPit(path);
  try {
    if (command === 'rebuild') console.log(JSON.stringify(rebuild(db)));
    if (command === 'stats' || command === 'migrate') {
      const counts = Object.fromEntries(
        ['raw', ...FACT_TABLES].map((table) => [
          table,
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
        ]),
      );
      const version = db.prepare('PRAGMA user_version').get().user_version;
      console.log(JSON.stringify({ path, schema_version: version, rows: counts }));
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
