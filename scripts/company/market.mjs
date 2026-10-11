/**
 * Market-side figures for the company report: consensus, broker targets, holders,
 * share count and trading averages.
 */
import { won } from './statements.mjs';

/**
 * `kis stock estimated-earnings` returns unlabelled rows (`data1`..`data5` per period).
 * Row order and units were identified against DART actuals for 192820 and 005930:
 * money rows are 억원; growth, EPS, PER, ROE and the rest come ×10 (005930 FY2023
 * EPS 2,131원 arrives as 21310, 매출 증감 -14.3% as -143). The net income row matches
 * DART's owners-of-parent figure, not the consolidated total.
 */
const SUMMARY_ROWS = [
  ['revenue', 1],
  ['revenueGrowth', 10],
  ['operatingIncome', 1],
  ['operatingIncomeGrowth', 10],
  ['netIncomeOwners', 1],
  ['netIncomeOwnersGrowth', 10],
];
// PER and EV/EBITDA are left out: KIS prices actual years at their year-end close and
// does not say which price the estimate years use.
const DETAIL_ROWS = [
  ['ebitda', 1],
  ['eps', 10],
  ['epsGrowth', 10],
  null,
  null,
  ['roe', 10],
  ['debtRatio', 10],
  ['interestCoverage', 10],
];

export function consensus(payload) {
  const periods = payload?.periods ?? [];
  if (periods.length === 0) return null;
  const years = periods.map(({ dt }) => ({ period: dt, estimate: dt.endsWith('E') }));
  const fill = (rows, layout) =>
    layout.forEach((slot, i) => {
      if (!slot || !rows?.[i]) return;
      const [key, divisor] = slot;
      years.forEach((year, j) => {
        const value = won(rows[i][`data${j + 1}`]);
        year[key] = value === null ? null : value / divisor;
      });
    });
  fill(payload.data, SUMMARY_ROWS);
  fill(payload.data_detail, DETAIL_ROWS);
  const { estdate, rcmd_name } = payload.summary ?? {};
  return { estimatedOn: estdate ?? null, rating: rcmd_name ?? null, unit: '억원', years };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Each broker's latest target in the window, newest first, with summary statistics. */
export function opinions(rows, since) {
  const latestBy = new Map();
  for (const row of rows ?? []) {
    const date = row.stck_bsop_date;
    const target = won(row.hts_goal_prc);
    if (!date || date < since || !target) continue;
    const seen = latestBy.get(row.mbcr_name);
    if (!seen || seen.date < date) {
      latestBy.set(row.mbcr_name, {
        broker: row.mbcr_name,
        date,
        rating: row.invt_opnn,
        previousRating: row.rgbf_invt_opnn,
        target,
      });
    }
  }
  const brokers = [...latestBy.values()].sort((a, b) => b.date.localeCompare(a.date));
  if (brokers.length === 0) return { since, count: 0, brokers };
  const targets = brokers.map((b) => b.target);
  const top = brokers.reduce((a, b) => (b.target > a.target ? b : a));
  const bottom = brokers.reduce((a, b) => (b.target < a.target ? b : a));
  const ratings = {};
  for (const { rating } of brokers) {
    const key = String(rating ?? '').toUpperCase();
    ratings[key] = (ratings[key] ?? 0) + 1;
  }
  return {
    since,
    count: brokers.length,
    mean: targets.reduce((sum, t) => sum + t, 0) / targets.length,
    median: median(targets),
    max: { target: top.target, broker: top.broker, date: top.date },
    min: { target: bottom.target, broker: bottom.broker, date: bottom.date },
    ratings,
    brokers,
  };
}

/** Largest shareholder and the related-party total from `dart major-shareholder`. */
export function holders(list) {
  const rows = (list ?? []).filter((row) => row.nm && row.nm !== '계');
  if (rows.length === 0) return null;
  const ratio = (row) => won(row.trmend_posesn_stock_qota_rt) ?? 0;
  const common = rows.filter((row) => row.stock_knd?.includes('보통'));
  const largest = common.find((row) => row.relate === '최대주주') ?? common[0] ?? rows[0];
  return {
    asOf: largest.stlm_dt ?? null,
    largest: { name: largest.nm, ratio: ratio(largest) },
    relatedTotal: common.reduce((sum, row) => sum + ratio(row), 0),
    top: [...common]
      .sort((a, b) => ratio(b) - ratio(a))
      .slice(0, 5)
      .map((row) => ({ name: row.nm, relate: row.relate, ratio: ratio(row) })),
  };
}

/** Common-share count from `dart share-count`. */
export function shareCount(list) {
  const row = (list ?? []).find((r) => r.se === '보통주');
  if (!row) return null;
  return {
    asOf: row.stlm_dt ?? null,
    issued: won(row.istc_totqy),
    treasury: won(row.tesstk_co),
    outstanding: won(row.distb_stock_co),
  };
}

/** Average volume and traded value over the last `sessions` candles. */
export function tradingAverage(candles, sessions = 60) {
  const window = candles.slice(-sessions);
  if (window.length < sessions) return null;
  const mean = (key) => window.reduce((sum, c) => sum + c[key], 0) / window.length;
  return {
    sessions,
    from: window[0].date,
    to: window.at(-1).date,
    volume: mean('volume'),
    value: mean('value'),
  };
}
