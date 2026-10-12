#!/usr/bin/env node
/**
 * Company report data — everything the market-review report format needs that is a
 * lookup or arithmetic, collected in one run.
 *
 *   node scripts/company.mjs collect --symbol 192820 [--as-of YYYYMMDD]
 *
 * Prints one JSON object: Key Data, consensus, broker targets, single quarters (YTD
 * differences), three fiscal years of statements with ratios, the latest filed period,
 * valuation at the reference close, and a year of disclosure titles. Money is in 억원.
 *
 * The agent used to fetch these piece by piece and re-derive the quarters by hand, which
 * took most of a run and was re-checked afterwards; the same input now gives the same
 * numbers. Calls run one after another (KIS allows two at a time; this keeps it simple).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consensus, holders, opinions, shareCount, tradingAverage } from './company/market.mjs';
import {
  annual,
  INCOME_ITEMS,
  latest,
  QUARTER_OF,
  quarters,
  trailing,
} from './company/statements.mjs';
import { lookbackStart } from './lib/atr.mjs';
import { CluefinError, dailyCandles, run, SECTOR, sectorDaily } from './lib/cluefin.mjs';
import { kstClock, SETTLED_MINUTES } from './lib/kst.mjs';

/** Calendar days of candles: enough for 52 weeks plus the 60-session average. */
const CANDLE_DAYS = 380;
const OPINION_DAYS = 90;
const DISCLOSURE_DAYS = 365;
const QUARTERS_SHOWN = 8;
const REPORT_CODES = Object.keys(QUARTER_OF);

const MONEY = new Set([
  ...Object.keys(INCOME_ITEMS),
  'assets',
  'currentAssets',
  'cash',
  'receivables',
  'inventories',
  'noncurrentAssets',
  'currentLiabilities',
  'noncurrentLiabilities',
  'liabilities',
  'equity',
  'equityOwners',
  'operatingCashFlow',
  'investingCashFlow',
  'financingCashFlow',
  'capex',
  'dividendsPaid',
  'interestExpense',
  'borrowings',
  'netDebt',
  'freeCashFlow',
]);

/**
 * Won → 억원 for the money fields of one statement object. Not recursive on purpose:
 * `yoy` reuses the item names for percentages, and consensus already comes in 억원.
 */
export function toEok(figures) {
  if (!figures) return figures;
  return Object.fromEntries(
    Object.entries(figures).map(([key, v]) => [
      key,
      MONEY.has(key) && typeof v === 'number' ? v / 1e8 : v,
    ]),
  );
}

/** Numbers rounded to 2 decimals for reading. */
function present(value) {
  if (typeof value === 'number')
    return Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(present);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, present(v)]));
  }
  return value;
}

const filedOn = (rceptNo) => String(rceptNo ?? '').slice(0, 8);

/** Every periodic report of `years` filed by `asOf`, consolidated if the filer has any. */
function fetchReports(cli, corpCode, years, asOf) {
  for (const basis of ['CFS', 'OFS']) {
    const reports = [];
    for (const year of years) {
      for (const reprtCode of REPORT_CODES) {
        const payload = cli([
          'dart',
          'financial-full-statements',
          '--corp-code',
          corpCode,
          '--bsns-year',
          String(year),
          '--reprt-code',
          reprtCode,
          '--fs-div',
          basis,
        ]);
        const rows = payload.result?.list ?? [];
        if (rows.length === 0 || filedOn(rows[0].rcept_no) > asOf) continue;
        reports.push({ year, reprtCode, rceptNo: rows[0].rcept_no, rows });
      }
    }
    if (reports.length > 0) return { basis, reports };
  }
  return { basis: null, reports: [] };
}

const order = (r) => r.year * 10 + QUARTER_OF[r.reprtCode];

function keyData({ cli, symbol, corpCode, asOf, today, intraday, market, latestReport }) {
  const from = lookbackStart(asOf, CANDLE_DAYS);
  const candles = dailyCandles(symbol, from, asOf, { cli });
  if (intraday && candles.at(-1)?.date === asOf) candles.pop();
  const last = candles.at(-1) ?? null;
  const trading = tradingAverage(candles);
  const year = candles.filter((c) => c.date > lookbackStart(last?.date ?? asOf, 365));

  const indexCode = market === 'KOSDAQ' ? SECTOR.KOSDAQ : SECTOR.KOSPI;
  const index = sectorDaily(indexCode, asOf, { cli });
  if (intraday && index.at(-1)?.date === asOf) index.pop();
  const [prevIndex, lastIndex] = index.slice(-2);

  const shareArgs = ['--corp-code', corpCode, '--bsns-year', String(latestReport.year)];
  const shares = shareCount(
    cli(['dart', 'share-count', ...shareArgs, '--reprt-code', latestReport.reprtCode]).result?.list,
  );
  const holder = holders(
    cli(['dart', 'major-shareholder', ...shareArgs, '--reprt-code', latestReport.reprtCode]).result
      ?.list,
  );
  // Foreign ownership has no as-of source; it is read only when the reference day is today.
  const live =
    asOf === today ? cli(['kis', 'stock', 'current-price', '--stock-code', symbol]) : null;

  return {
    price: last && {
      date: last.date,
      close: last.close,
      intradayPrice: intraday ? (live?.current_price ?? null) : null,
    },
    week52: year.length
      ? {
          high: Math.max(...year.map((c) => c.high)),
          low: Math.min(...year.map((c) => c.low)),
        }
      : null,
    trading: trading && { ...trading, value: trading.value / 1e8 },
    index: lastIndex && {
      code: indexCode,
      date: lastIndex.date,
      close: lastIndex.close,
      change: prevIndex ? (lastIndex.close / prevIndex.close - 1) * 100 : null,
    },
    shares,
    holders: holder,
    foreignRatio: live?.foreign_ratio ?? null,
  };
}

function valuation({ close, shares, quarterList, latestFigures, consensusData }) {
  if (!close || !shares?.outstanding) return null;
  const marketCap = close * shares.outstanding;
  const ttm = trailing(quarterList, 'netIncomeOwners');
  const perOf = (eps) => (eps ? close / eps : null);
  return {
    basis: `종가 ${close}원 × 유통주식수 ${shares.outstanding}주`,
    marketCap: marketCap / 1e8,
    ttmNetIncomeOwners: ttm === null ? null : ttm / 1e8,
    perTtm: ttm && ttm > 0 ? marketCap / ttm : null,
    pbr: latestFigures?.equityOwners ? marketCap / latestFigures.equityOwners : null,
    perByYear: (consensusData?.years ?? []).map((y) => ({
      period: y.period,
      estimate: y.estimate,
      eps: y.eps,
      per: perOf(y.eps),
    })),
  };
}

const FLAGS = new Set(['symbol', 'as-of']);

/** The `collect` command. Null on a usage error. */
export function collect(flags, { cli = run, now = new Date() } = {}) {
  if (Object.keys(flags).some((key) => !FLAGS.has(key))) return null;
  const { symbol } = flags;
  const asOfFlag = flags['as-of'];
  if (!/^\d{6}$/.test(symbol ?? '')) return null;
  if (asOfFlag && !/^\d{8}$/.test(asOfFlag)) return null;

  const clock = kstClock(now);
  const asOf = asOfFlag ?? clock.date;
  const intraday = asOf === clock.date && clock.minutes < SETTLED_MINUTES;

  const corpCode = cli(['dart', 'corp-code-lookup', '--stock-code', symbol]).data?.[0]?.corp_code;
  if (!corpCode) throw new Error(`DART 기업코드를 찾지 못했다: ${symbol}`);
  const overviewPayload = cli(['dart', 'company-overview', '--corp-code', corpCode]);
  const overview = overviewPayload.result ?? overviewPayload;
  const market = { Y: 'KOSPI', K: 'KOSDAQ' }[overview.corp_cls] ?? null;

  const year = Number(asOf.slice(0, 4));
  let fetched = fetchReports(cli, corpCode, [year - 1, year], asOf);
  if (!fetched.reports.some((r) => r.year === year)) {
    fetched = fetchReports(cli, corpCode, [year - 2, year - 1], asOf);
  }
  const { basis, reports } = fetched;
  if (reports.length === 0) throw new Error(`${asOf}까지 제출된 정기보고서가 없다: ${symbol}`);
  const latestReport = reports.reduce((a, b) => (order(b) > order(a) ? b : a));
  const annualReport = reports
    .filter((r) => r.reprtCode === '11011')
    .reduce((a, b) => (!a || b.year > a.year ? b : a), null);

  const quarterList = quarters(reports).slice(-QUARTERS_SHOWN);
  const latestFigures = latest(latestReport);
  const key = keyData({
    cli,
    symbol,
    corpCode,
    asOf,
    today: clock.date,
    intraday,
    market,
    latestReport,
  });

  const consensusData = consensus(
    cli(['kis', 'stock', 'estimated-earnings', '--stock-code', symbol]),
  );
  const since = lookbackStart(asOf, OPINION_DAYS);
  const opinionRows = cli([
    'kis',
    'stock',
    'investment-opinion',
    '--stock-code',
    symbol,
    '--start-date',
    `00${since}`,
    '--end-date',
    `00${asOf}`,
  ]).data;

  const disclosurePayload = cli([
    'dart',
    'disclosure-search',
    '--corp-code',
    corpCode,
    '--bgn-de',
    lookbackStart(asOf, DISCLOSURE_DAYS),
    '--end-de',
    asOf,
    '--page-count',
    '100',
  ]).result;
  const disclosureList = disclosurePayload?.list ?? [];

  return present({
    symbol,
    name: overview.stock_name ?? overview.corp_name ?? null,
    market,
    corpCode,
    asOf,
    intraday,
    statementBasis: basis,
    keyData: key,
    consensus: consensusData,
    opinions: opinions(opinionRows, since),
    valuation: valuation({
      close: key.price?.close,
      shares: key.shares,
      quarterList,
      latestFigures,
      consensusData,
    }),
    quarters: quarterList.map(toEok),
    annual: annualReport ? annual(annualReport).map(toEok) : [],
    latest: toEok(latestFigures),
    disclosures: {
      from: lookbackStart(asOf, DISCLOSURE_DAYS),
      total: disclosurePayload?.total_count ?? disclosureList.length,
      list: disclosureList.map((d) => ({
        date: d.rcept_dt,
        title: d.report_nm.trim(),
        filer: d.flr_nm,
        rceptNo: d.rcept_no,
      })),
    },
    sources: {
      statements: reports.map((r) => `dart-${r.reprtCode} ${r.year} (${filedOn(r.rceptNo)} 접수)`),
      consensus: 'kis stock estimated-earnings',
      opinions: 'kis stock investment-opinion',
      price: 'kis chart period (수정주가)',
    },
    notes: [
      '금액 단위는 억원. 분기 Q2~Q4는 누적에서 뺀 값(4Q = 연간 − 9개월 누적)이다.',
      'gpm·opm·debtRatio·netDebtRatio·interestCoverage·roe·roa·freeCashFlow(영업CF − 유형자산 취득)·valuation은 계산값이다.',
      'interestCoverage의 이자비용은 현금흐름표 조정 항목의 이자비용이다.',
      '공시는 제목·접수번호만 있다. 금액·상대방은 cluefin으로 알 수 없다.',
      '컨센서스 PER·EV/EBITDA는 기준 가격이 불분명해 뺐다. valuation.perByYear가 기준 종가로 다시 계산한 값이다.',
    ],
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

const USAGE = 'usage: node scripts/company.mjs collect --symbol <6자리> [--as-of YYYYMMDD]';

export async function main(argv, deps = {}) {
  const { command, flags, error } = parseArgs(argv);
  if (error || command !== 'collect') {
    console.error(error ?? USAGE);
    return 2;
  }
  let result;
  try {
    result = collect(flags, deps);
  } catch (cause) {
    const code = cause instanceof CluefinError ? cause.code : 1;
    console.error(JSON.stringify({ error: { message: cause.message, exit_code: code } }));
    return code;
  }
  if (result === null) {
    console.error(USAGE);
    return 2;
  }
  // Compact: the agent reads this into its context, and indentation is a third of the bytes.
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
