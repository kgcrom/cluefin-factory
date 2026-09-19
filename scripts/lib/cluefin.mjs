import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CWD = join(homedir(), 'workspace/cluefin');

/**
 * Exit codes are a contract: 2 usage, 3 credentials, 4 broker/network
 * (retry only when `error.retryable`), 5 rate limit.
 */
export class CluefinError extends Error {
  constructor(code, detail) {
    super(`cluefin CLI exit ${code}: ${detail}`);
    this.code = code;
    this.retryable = code === 4 && /"retryable":\s*true/.test(detail);
  }
}

function run(args, { cwd = process.env.CLUEFIN_OPENAPI_CWD || DEFAULT_CWD } = {}) {
  try {
    return JSON.parse(
      execFileSync('uv', ['run', 'cluefin-openapi-cli', ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  } catch (cause) {
    throw new CluefinError(cause.status ?? 1, cause.stdout ?? cause.message);
  }
}

const candle = (row) => ({
  date: row.stck_bsop_date,
  close: Number(row.stck_clpr),
  high: Number(row.stck_hgpr),
  low: Number(row.stck_lwpr),
});

const byDate = (a, b) => a.date.localeCompare(b.date);

const MAX_PAGES = 24;

/** The day before `yyyymmdd`, as the next page's end date. */
export function previousDay(yyyymmdd) {
  const at = Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  );
  return new Date(at - 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * Both `chart period` and `sector daily` cap a response at 100 rows and silently
 * drop the rest of the requested window — the series comes back short rather than
 * erroring, so a long window yields a benchmark or a candle scan that never
 * reaches the judgment's reference date. Page backwards from the end and merge.
 */
export function pageBackwards(fetchPage, from, to) {
  const merged = new Map();
  let endingOn = to;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = fetchPage(endingOn);
    if (rows.length === 0) break;
    for (const row of rows) merged.set(row.date, row);
    const earliest = rows[0].date;
    if (earliest <= from) break;
    const next = previousDay(earliest);
    if (next >= endingOn) break; // no progress — stop rather than loop forever
    endingOn = next;
  }
  return [...merged.values()].filter((row) => row.date >= from && row.date <= to).sort(byDate);
}

function candlePage(symbol, start, end, options) {
  const payload = run(
    [
      'kis',
      'chart',
      'period',
      '--stock-code',
      symbol,
      '--start-date',
      start,
      '--end-date',
      end,
      '--period',
      'D',
      '--adj-price',
      '0',
    ],
    options,
  );
  return payload.data.map(candle).sort(byDate);
}

/** Adjusted daily candles covering [start, end], paged as needed. */
export function dailyCandles(symbol, start, end, options = {}) {
  const fetchPage =
    options.fetchPage ?? ((endingOn) => candlePage(symbol, start, endingOn, options));
  return pageBackwards(fetchPage, start, end);
}

export const SECTOR = { KOSPI: '0001', KOSDAQ: '1001', KOSPI200: '2001' };

/**
 * Index closes. `--start-date` is an END date: the CLI returns the 100 trading
 * days *ending* on it, so the parameter is named `endingOn` here to stop the
 * trap being re-learned at every call site. Windows longer than ~5 months need
 * several calls merged.
 */
export function sectorDaily(sectorCode, endingOn, options) {
  const payload = run(
    ['kis', 'sector', 'daily', '--sector-code', sectorCode, '--start-date', endingOn],
    options,
  );
  return payload.data
    .map((row) => ({ date: row.stck_bsop_date, close: Number(row.bstp_nmix_prpr) }))
    .sort(byDate);
}

/** Index closes covering [from, to], paged as needed. */
export function sectorDailyRange(sectorCode, from, to, options = {}) {
  const fetchPage = options.fetchPage ?? ((endingOn) => sectorDaily(sectorCode, endingOn, options));
  return pageBackwards(fetchPage, from, to);
}

export function benchmarkFor(market) {
  return market === 'KOSDAQ' ? SECTOR.KOSDAQ : SECTOR.KOSPI200;
}
