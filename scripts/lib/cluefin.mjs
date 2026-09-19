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

/** Adjusted daily candles for [start, end]. */
export function dailyCandles(symbol, start, end, options) {
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

export function benchmarkFor(market) {
  return market === 'KOSDAQ' ? SECTOR.KOSDAQ : SECTOR.KOSPI200;
}
