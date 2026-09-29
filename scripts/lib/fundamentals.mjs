/**
 * Non-price invalidation predicates, evaluated against periodic reports filed
 * during the judgment's window.
 *
 * A condition such as `operating_profit_growth_yoy < 0` can only change when a
 * new report is filed, so it is checked once per report, and it fires on the
 * first trading day after the filing date — the report was not known before then.
 * The values come from `dart financial-major-indicators`, which returns the
 * latest amended filing for a period; the filing date used is the earliest one
 * for that period, i.e. when the period's figures first became public.
 */

/**
 * The metric names a judgment may use, and where each lives in DART's indicator
 * response. A metric outside this map stays a manual condition.
 */
export const FUNDAMENTAL_METRICS = {
  revenue_growth_yoy: { idxClCode: 'M230000', idxNm: '매출액증가율(YoY)' },
  operating_profit_growth_yoy: { idxClCode: 'M230000', idxNm: '영업이익증가율(YoY)' },
  net_income_growth_yoy: { idxClCode: 'M230000', idxNm: '순이익증가율(YoY)' },
  roe: { idxClCode: 'M210000', idxNm: 'ROE' },
  net_margin: { idxClCode: 'M210000', idxNm: '순이익률' },
  gross_margin: { idxClCode: 'M210000', idxNm: '매출총이익률' },
  debt_to_equity: { idxClCode: 'M220000', idxNm: '부채비율' },
  current_ratio: { idxClCode: 'M220000', idxNm: '유동비율' },
  equity_ratio: { idxClCode: 'M220000', idxNm: '자기자본비율' },
};

/** `(YYYY.MM)` month in a periodic report title → DART report code. */
const REPORT_CODE_BY_MONTH = { '03': '11013', '06': '11012', '09': '11014', 12: '11011' };

/**
 * `반기보고서 (2026.06)`, `[기재정정]사업보고서 (2025.12)` → the period it covers.
 * A fiscal year that does not end in December keeps the month in the title, so
 * the mapping is by title month, not by report kind. Null for anything else.
 */
export function periodOf(reportName) {
  const match = String(reportName).match(/(?:사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/);
  if (!match) return null;
  const reprtCode = REPORT_CODE_BY_MONTH[match[2]];
  return reprtCode ? { bsnsYear: match[1], reprtCode } : null;
}

/**
 * Periodic reports first filed in (from, to], one per period, oldest first.
 * An amendment filed later does not move the period's date: the figures were
 * already public from the first filing.
 */
export function periodicReports(disclosures, from, to) {
  const earliest = new Map();
  for (const row of disclosures) {
    const period = periodOf(row.report_nm);
    if (!period) continue;
    const key = `${period.bsnsYear}-${period.reprtCode}`;
    const seen = earliest.get(key);
    if (!seen || row.rcept_dt < seen.filedOn) {
      earliest.set(key, { ...period, filedOn: row.rcept_dt });
    }
  }
  return [...earliest.values()]
    .filter((report) => report.filedOn > from && report.filedOn <= to)
    .sort((a, b) => a.filedOn.localeCompare(b.filedOn));
}

/** DART writes `null` or `#########` (overflow) where it has no value. */
export function indicatorValue(rows, idxNm) {
  const row = rows.find((r) => r.idx_nm === idxNm);
  const value = Number(row?.idx_val);
  return row && row.idx_val !== null && Number.isFinite(value) ? value : null;
}

/** Whether a checkable condition is one this module evaluates. */
export function isFundamental(item) {
  return item.checkable === true && item.metric in FUNDAMENTAL_METRICS;
}

/**
 * Attach each needed metric's value to each report. `fetchIndicators(report,
 * idxClCode)` returns DART's `result.list` rows; one call per indicator class.
 */
export function withValues(reports, metrics, fetchIndicators) {
  const classes = [...new Set(metrics.map((metric) => FUNDAMENTAL_METRICS[metric].idxClCode))];
  return reports.map((report) => {
    const rowsByClass = Object.fromEntries(
      classes.map((idxClCode) => [idxClCode, fetchIndicators(report, idxClCode)]),
    );
    const values = Object.fromEntries(
      metrics.map((metric) => {
        const { idxClCode, idxNm } = FUNDAMENTAL_METRICS[metric];
        return [metric, indicatorValue(rowsByClass[idxClCode], idxNm)];
      }),
    );
    return { ...report, values };
  });
}

/** First trading day strictly after `date` — when a filing becomes known. */
function knownFrom(series, date) {
  return series.find((row) => row.date > date)?.date ?? null;
}

/**
 * First date a fundamental condition fires. A report whose value is missing makes
 * the condition manual rather than silently passing: it could not be checked.
 */
export function fundamentalTrigger(item, compare, reports, series) {
  for (const report of reports) {
    const value = report.values?.[item.metric];
    if (value === null || value === undefined) return { manual: true };
    if (!compare(value, item.value)) continue;
    const date = knownFrom(series, report.filedOn);
    if (date) return { hit: { date, report: `${report.bsnsYear}-${report.reprtCode}` } };
  }
  return {};
}
