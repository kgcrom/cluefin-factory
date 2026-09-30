/**
 * The PIT store: the only module that touches `node:sqlite`, which is still
 * experimental in Node 22 — if its API moves, this file is the one to change.
 *
 * Two time axes on every fact: the period a value describes and `known_at`, the
 * first trading day it could have been acted on. `*AsOf` queries return only
 * what was known by a date; `financialsLatest` returns the newest amendment of
 * every period (what the DART JSON API serves today).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { nextTradingDay } from './calendar.mjs';
import { PARSERS, SOURCE_ORDER } from './parsers.mjs';

const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url));
const CALENDAR_SECTOR = '0001';

export class PitError extends Error {}

/** `[{ version, name, sql }]`, ascending — `NNN-name.sql` files in migrations/. */
export function migrations(dir = MIGRATIONS) {
  return readdirSync(dir)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort()
    .map((file) => ({
      version: Number(file.slice(0, 3)),
      name: file,
      sql: readFileSync(join(dir, file), 'utf8'),
    }));
}

function transaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Bring the schema to the newest migration. A database written by newer code
 * (a higher `user_version` than any migration here) is refused, not downgraded.
 */
export function migrate(db, dir = MIGRATIONS) {
  const steps = migrations(dir);
  const latest = steps.at(-1)?.version ?? 0;
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > latest) {
    throw new PitError(`DB 스키마 버전 ${current}이 이 코드(${latest})보다 새롭다`);
  }
  for (const step of steps.filter((s) => s.version > current)) {
    transaction(db, () => {
      db.exec(step.sql);
      db.exec(`PRAGMA user_version = ${step.version}`);
    });
  }
  return latest;
}

/** Open (creating if needed) and migrate. `:memory:` for tests. */
export function openPit(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

/**
 * The raw row's key: source, parameters (keys sorted) and the body text as
 * received. Re-fetching an unchanged response is a no-op.
 */
export function rawKey(source, params, bodyText) {
  const sorted = Object.fromEntries(
    Object.keys(params)
      .sort()
      .map((key) => [key, params[key]]),
  );
  return createHash('sha256')
    .update(`${source}\n${JSON.stringify(sorted)}\n${bodyText}`)
    .digest('hex');
}

export function tradingCalendar(db) {
  return db
    .prepare('SELECT date FROM index_prices WHERE sector_code = ? ORDER BY date')
    .all(CALENDAR_SECTOR)
    .map((row) => row.date);
}

const UPSERT = {
  prices: `INSERT INTO prices (symbol, date, open, high, low, close, volume, value, fetched_at, raw_sha256)
    VALUES (:symbol, :date, :open, :high, :low, :close, :volume, :value, :fetched_at, :raw_sha256)
    ON CONFLICT (symbol, date) DO UPDATE SET open = excluded.open, high = excluded.high,
      low = excluded.low, close = excluded.close, volume = excluded.volume, value = excluded.value,
      fetched_at = excluded.fetched_at, raw_sha256 = excluded.raw_sha256
    WHERE excluded.fetched_at >= prices.fetched_at`,
  index_prices: `INSERT INTO index_prices (sector_code, date, close, fetched_at, raw_sha256)
    VALUES (:sector_code, :date, :close, :fetched_at, :raw_sha256)
    ON CONFLICT (sector_code, date) DO UPDATE SET close = excluded.close,
      fetched_at = excluded.fetched_at, raw_sha256 = excluded.raw_sha256
    WHERE excluded.fetched_at >= index_prices.fetched_at`,
  // A filing never changes once accepted; the first copy stays.
  disclosures: `INSERT INTO disclosures (rcept_no, corp_code, rcept_dt, known_at, report_nm, raw_sha256)
    VALUES (:rcept_no, :corp_code, :rcept_dt, :known_at, :report_nm, :raw_sha256)
    ON CONFLICT (rcept_no) DO NOTHING`,
  financials: `INSERT INTO financials (corp_code, bsns_year, reprt_code, fs_div, account_id, value,
      is_cumulative, period_end, rcept_no, known_at, raw_sha256)
    VALUES (:corp_code, :bsns_year, :reprt_code, :fs_div, :account_id, :value,
      :is_cumulative, :period_end, :rcept_no, :known_at, :raw_sha256)`,
};

export const FACT_TABLES = Object.keys(UPSERT);

/** The `:name` parameters a statement binds, so a row supplies exactly those. */
const bound = (sql) => [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))];

function insertRows(db, table, rows, stamp) {
  const statement = db.prepare(UPSERT[table]);
  const names = bound(UPSERT[table]);
  for (const row of rows) {
    const values = { ...row, ...stamp };
    const missing = names.filter((name) => values[name] === undefined);
    // An unbound parameter would load as NULL — a silent gap, not a missing field error.
    if (missing.length > 0) throw new PitError(`${table}: ${missing.join(', ')} 값이 없다`);
    statement.run(Object.fromEntries(names.map((name) => [name, values[name]])));
  }
  return rows.length;
}

function parseRaw(db, raw) {
  const parser = PARSERS[raw.source];
  if (!parser) return { parsed: false, rows: {}, skipped: 0 };
  const calendar = tradingCalendar(db);
  const { rows, skipped } = parser(JSON.parse(raw.body), JSON.parse(raw.params), {
    nextTradingDay: (date) => nextTradingDay(calendar, date),
  });
  const stamp = { fetched_at: raw.fetched_at, raw_sha256: raw.sha256 };
  const counts = {};
  for (const [table, list] of Object.entries(rows))
    counts[table] = insertRows(db, table, list, stamp);
  return { parsed: true, rows: counts, skipped };
}

/**
 * Store one CLI response and load its facts. A source with no parser yet is
 * kept raw-only (`parsed: false`) so it can be loaded by a later rebuild.
 */
export function ingest(db, { source, params = {}, body, fetchedAt }) {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  const sha256 = rawKey(source, params, bodyText);
  if (db.prepare('SELECT 1 FROM raw WHERE sha256 = ?').get(sha256)) {
    return { sha256, inserted: false, parsed: false, rows: {}, skipped: 0 };
  }
  return transaction(db, () => {
    const raw = {
      sha256,
      source,
      params: JSON.stringify(params),
      fetched_at: fetchedAt,
      body: bodyText,
    };
    db.prepare(
      'INSERT INTO raw (sha256, source, params, fetched_at, body) VALUES (:sha256, :source, :params, :fetched_at, :body)',
    ).run(raw);
    return { sha256, inserted: true, ...parseRaw(db, raw) };
  });
}

/**
 * Load facts that are not derived from a CLI parser yet (XBRL financials until
 * the cluefin command lands). Rows must point at a stored raw response.
 */
export function loadFacts(db, table, rows, rawSha256) {
  if (!FACT_TABLES.includes(table)) throw new PitError(`모르는 테이블 ${table}`);
  const raw = db.prepare('SELECT fetched_at FROM raw WHERE sha256 = ?').get(rawSha256);
  if (!raw) throw new PitError(`raw ${rawSha256}가 없다`);
  return transaction(db, () =>
    insertRows(db, table, rows, { fetched_at: raw.fetched_at, raw_sha256: rawSha256 }),
  );
}

/**
 * Drop every parser-derived fact and reload from raw — after a parser changes,
 * or once the calendar reaches filings that were skipped. Sources are replayed
 * calendar first, then in fetch order, so the result does not depend on the
 * order responses originally arrived in. Facts from `loadFacts` are kept.
 */
export function rebuild(db) {
  const order = (source) => {
    const at = SOURCE_ORDER.indexOf(source);
    return at === -1 ? SOURCE_ORDER.length : at;
  };
  return transaction(db, () => {
    for (const table of ['prices', 'index_prices', 'disclosures']) db.exec(`DELETE FROM ${table}`);
    const raws = db
      .prepare(
        'SELECT sha256, source, params, fetched_at, body FROM raw ORDER BY fetched_at, sha256',
      )
      .all()
      .filter((raw) => raw.source in PARSERS)
      .sort((a, b) => order(a.source) - order(b.source));
    let skipped = 0;
    for (const raw of raws) skipped += parseRaw(db, raw).skipped;
    return { replayed: raws.length, skipped };
  });
}

// ── as-of queries ────────────────────────────────────────────────────────────

/** Candles up to and including `asOf` — a close is known at the end of its day. */
export function pricesAsOf(db, symbol, asOf, { from = '00000000' } = {}) {
  return db
    .prepare(
      `SELECT date, open, high, low, close, volume, value FROM prices
       WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY date`,
    )
    .all(symbol, from, asOf);
}

export function indexAsOf(db, sectorCode, asOf, { from = '00000000' } = {}) {
  return db
    .prepare(
      `SELECT date, close FROM index_prices
       WHERE sector_code = ? AND date BETWEEN ? AND ? ORDER BY date`,
    )
    .all(sectorCode, from, asOf);
}

export function disclosuresAsOf(db, corpCode, asOf, { from = '00000000' } = {}) {
  return db
    .prepare(
      `SELECT rcept_no, rcept_dt, known_at, report_nm FROM disclosures
       WHERE corp_code = ? AND known_at BETWEEN ? AND ? ORDER BY known_at, rcept_no`,
    )
    .all(corpCode, from, asOf);
}

const FINANCIALS_PICK = `
  SELECT corp_code, bsns_year, reprt_code, fs_div, account_id, value, is_cumulative,
         period_end, rcept_no, known_at
  FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY bsns_year, reprt_code, fs_div, account_id, is_cumulative
      ORDER BY known_at DESC, rcept_no DESC
    ) AS pick
    FROM financials WHERE corp_code = ? AND known_at <= ?
  )
  WHERE pick = 1
  ORDER BY bsns_year, reprt_code, fs_div, account_id, is_cumulative`;

/** For each period and account, the filing that was newest as of `asOf`. */
export function financialsAsOf(db, corpCode, asOf) {
  return db.prepare(FINANCIALS_PICK).all(corpCode, asOf);
}

/** For each period and account, the newest filing held — today's view. */
export function financialsLatest(db, corpCode) {
  return db.prepare(FINANCIALS_PICK).all(corpCode, '99999999');
}
