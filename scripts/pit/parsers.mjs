/**
 * raw response → fact rows, one parser per CLI command. A parser reads only the
 * row arrays: KIS `summary` blocks describe the day of the fetch, not the
 * requested window, and loading them would put today's price into the past.
 *
 * Each parser returns `{ rows: { <table>: [row, …] }, skipped }`. A row it cannot
 * place yet (a filing newer than the trading calendar) is skipped, not guessed;
 * the raw response stays, and a later rebuild picks it up.
 */
import { compactDate, toInt, toReal } from './convert.mjs';

/** Parse order for rebuild: the calendar (index closes) before anything that needs it. */
export const SOURCE_ORDER = [
  'kis.sector.daily',
  'kis.chart.period',
  'kiwoom.analysis.institutional-trend',
  'kis.analysis.short-selling-trend',
  'kis.chart.technical',
  'dart.disclosure-search',
];

function chartPeriod(body, params) {
  const symbol = String(body.stock_code ?? params.stock_code);
  const prices = (body.data ?? []).map((row) => ({
    symbol,
    date: compactDate(row.stck_bsop_date),
    open: toInt(row.stck_oprc),
    high: toInt(row.stck_hgpr),
    low: toInt(row.stck_lwpr),
    close: toInt(row.stck_clpr),
    volume: toInt(row.acml_vol),
    value: toInt(row.acml_tr_pbmn),
  }));
  return { rows: { prices }, skipped: 0 };
}

function sectorDaily(body, params) {
  const sectorCode = String(params.sector_code);
  const index_prices = (body.data ?? []).map((row) => ({
    sector_code: sectorCode,
    date: compactDate(row.stck_bsop_date),
    close: toReal(row.bstp_nmix_prpr),
  }));
  return { rows: { index_prices }, skipped: 0 };
}

function disclosureSearch(body, _params, { nextTradingDay }) {
  const disclosures = [];
  let skipped = 0;
  for (const row of body.result?.list ?? []) {
    const rceptDt = compactDate(row.rcept_dt);
    const knownAt = nextTradingDay(rceptDt);
    if (knownAt === null) {
      skipped += 1;
      continue;
    }
    disclosures.push({
      rcept_no: String(row.rcept_no),
      corp_code: String(row.corp_code),
      rcept_dt: rceptDt,
      known_at: knownAt,
      report_nm: String(row.report_nm).trim(),
    });
  }
  return { rows: { disclosures }, skipped };
}

/**
 * Kiwoom's daily net buying by investor. The price columns carry a direction
 * sign and are not loaded; the `*_prsm_avg_pric` header fields are averages
 * over the requested window, not a daily value, and are not loaded either.
 */
function institutionalTrend(body, params) {
  const symbol = String(params.stock_code);
  const flows = (body.stk_orgn_trde_trnsn ?? []).map((row) => ({
    symbol,
    date: compactDate(row.dt),
    foreign_net_qty: toInt(row.for_daly_nettrde_qty),
    institution_net_qty: toInt(row.orgn_daly_nettrde_qty),
  }));
  return { rows: { flows }, skipped: 0 };
}

function shortSellingTrend(body, params) {
  const symbol = String(params.stock_code);
  const short_sales = (body.data ?? []).map((row) => ({
    symbol,
    date: compactDate(row.stck_bsop_date),
    short_qty: toInt(row.ssts_cntg_qty),
  }));
  return { rows: { short_sales }, skipped: 0 };
}

/** Kept whole — which readings survive masking is the case builder's call. */
function chartTechnical(body, params) {
  const technical = [
    {
      symbol: String(body.stock_code ?? params.stock_code),
      as_of: compactDate(body.as_of),
      candle_count: toInt(body.candle_count),
      body: JSON.stringify(body),
    },
  ];
  return { rows: { technical }, skipped: 0 };
}

export const PARSERS = {
  'kis.chart.period': chartPeriod,
  'kis.sector.daily': sectorDaily,
  'kiwoom.analysis.institutional-trend': institutionalTrend,
  'kis.analysis.short-selling-trend': shortSellingTrend,
  'kis.chart.technical': chartTechnical,
  'dart.disclosure-search': disclosureSearch,
};
