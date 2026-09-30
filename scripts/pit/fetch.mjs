/**
 * Fetch from the cluefin CLI into the PIT store. Every response is ingested as
 * its own raw row before anything is read out of it, so a page that fails to
 * parse leaves nothing half-loaded and a later rebuild never needs the network.
 *
 * `chart period`, `sector daily`, `institutional-trend` and `short-selling-trend`
 * all return the newest 100 rows of the requested window and drop the rest
 * silently, so every range is paged backwards from its end.
 */
import { CluefinError, pageBackwards, run } from '../lib/cluefin.mjs';
import { compactDate } from './convert.mjs';
import { ingest } from './db.mjs';
import { nonBlankRows } from './parsers.mjs';

const DAY_MS = 86_400_000;
const CALENDAR_SECTOR = '0001';
const RETRY_DELAYS_MS = [1000, 2000, 4000];
/** Calendar days before as_of fetched for a case: 120 sessions plus holidays. */
const LOOKBACK_DAYS = 200;
export const TECHNICAL_CANDLES = 120;

const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function shiftDays(compact, days) {
  const at = Date.UTC(
    Number(compact.slice(0, 4)),
    Number(compact.slice(4, 6)) - 1,
    Number(compact.slice(6, 8)),
  );
  return new Date(at + days * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * `{ cli, clock, sleep }` are injectable for tests. Rate limits (exit 5) and
 * broker errors the CLI marks retryable are retried with backoff; anything else
 * is thrown at once.
 */
export function createFetcher(
  db,
  { cli = run, clock = () => new Date().toISOString(), sleep = blockingSleep } = {},
) {
  function call(source, args, params) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const body = cli(args);
        ingest(db, { source, params, body, fetchedAt: clock() });
        return body;
      } catch (error) {
        const transient = error instanceof CluefinError && (error.code === 5 || error.retryable);
        if (!transient || attempt >= RETRY_DELAYS_MS.length) throw error;
        sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  const byDate = (rows) => rows.sort((a, b) => a.date.localeCompare(b.date));

  function prices(symbol, from, to) {
    return pageBackwards(
      (endingOn) => {
        const params = {
          stock_code: symbol,
          start_date: from,
          end_date: endingOn,
          period: 'D',
          adj_price: '0',
        };
        const body = call(
          'kis.chart.period',
          [
            'kis',
            'chart',
            'period',
            '--stock-code',
            symbol,
            '--start-date',
            from,
            '--end-date',
            endingOn,
            '--period',
            'D',
            '--adj-price',
            '0',
          ],
          params,
        );
        return byDate(
          nonBlankRows(body.data).map((row) => ({ date: compactDate(row.stck_bsop_date) })),
        );
      },
      from,
      to,
    );
  }

  /** `--start-date` is the END of the 100-session window (AGENTS.md gotcha). */
  function index(sectorCode, from, to) {
    return pageBackwards(
      (endingOn) => {
        const body = call(
          'kis.sector.daily',
          ['kis', 'sector', 'daily', '--sector-code', sectorCode, '--start-date', endingOn],
          { sector_code: sectorCode, start_date: endingOn },
        );
        return byDate(
          nonBlankRows(body.data).map((row) => ({ date: compactDate(row.stck_bsop_date) })),
        );
      },
      from,
      to,
    );
  }

  function flows(symbol, from, to) {
    return pageBackwards(
      (endingOn) => {
        const body = call(
          'kiwoom.analysis.institutional-trend',
          [
            'kiwoom',
            'analysis',
            'institutional-trend',
            '--stock-code',
            symbol,
            '--start-date',
            from,
            '--end-date',
            endingOn,
            '--orgn-prsm-unp-tp',
            '1',
            '--for-prsm-unp-tp',
            '1',
          ],
          { stock_code: symbol, start_date: from, end_date: endingOn },
        );
        return byDate(
          nonBlankRows(body.stk_orgn_trde_trnsn).map((row) => ({ date: compactDate(row.dt) })),
        );
      },
      from,
      to,
    );
  }

  function shortSales(symbol, from, to) {
    return pageBackwards(
      (endingOn) => {
        const body = call(
          'kis.analysis.short-selling-trend',
          [
            'kis',
            'analysis',
            'short-selling-trend',
            '--stock-code',
            symbol,
            '--start-date',
            from,
            '--end-date',
            endingOn,
          ],
          { stock_code: symbol, start_date: from, end_date: endingOn },
        );
        return byDate(
          nonBlankRows(body.data).map((row) => ({ date: compactDate(row.stck_bsop_date) })),
        );
      },
      from,
      to,
    );
  }

  function technical(symbol, asOf, count = TECHNICAL_CANDLES) {
    return call(
      'kis.chart.technical',
      [
        'kis',
        'chart',
        'technical',
        '--stock-code',
        symbol,
        '--end-date',
        asOf,
        '--count',
        String(count),
      ],
      { stock_code: symbol, end_date: asOf, count },
    );
  }

  /**
   * Everything a price-and-flow blind case needs for (symbol, as_of): candles
   * and benchmark from ~120 sessions before as_of through the end of the horizon
   * (scoring reads the candles after as_of from here too), the KOSPI calendar
   * over the same span, flows up to as_of, and the technical reading on as_of.
   */
  function fillCase({ symbol, asOf, benchmarkCode, horizonDays = 120, today }) {
    const from = shiftDays(asOf, -LOOKBACK_DAYS);
    const horizonEnd = shiftDays(asOf, Math.ceil((horizonDays * 7) / 5) + 14);
    const to = today && horizonEnd > today ? today : horizonEnd;
    const counts = {
      prices: prices(symbol, from, to).length,
      calendar: index(CALENDAR_SECTOR, from, to).length,
    };
    counts.index =
      benchmarkCode === CALENDAR_SECTOR ? counts.calendar : index(benchmarkCode, from, to).length;
    counts.flows = flows(symbol, from, asOf).length;
    counts.short_sales = shortSales(symbol, from, asOf).length;
    counts.technical_as_of = technical(symbol, asOf).as_of;
    return counts;
  }

  return { prices, index, flows, shortSales, technical, fillCase };
}
