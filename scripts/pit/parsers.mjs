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
export const SOURCE_ORDER = ['kis.sector.daily', 'kis.chart.period', 'dart.disclosure-search'];

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

export const PARSERS = {
  'kis.chart.period': chartPeriod,
  'kis.sector.daily': sectorDaily,
  'dart.disclosure-search': disclosureSearch,
};
