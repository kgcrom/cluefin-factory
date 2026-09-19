/**
 * Rule checks that `final-decision` states in prose. Each one is a pure function
 * over parsed frontmatter so the rule lives here, not in two places.
 *
 * Severities: `error` fails the lint, `warn` and `info` only report.
 */

const DAY_MS = 86_400_000;
const STOP_CAP_PCT = 20;

export const DEFAULT_CUTOFF = '2026-05';

const finding = (rule, severity, message) => ({ rule, severity, message });

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function daysBetween(from, to) {
  return Math.round((to - from) / DAY_MS);
}

/** Last day of the cutoff month — the boundary `leakage_risk` is measured from. */
export function cutoffBoundary(cutoff = DEFAULT_CUTOFF) {
  const [year, month] = cutoff.split('-').map(Number);
  return Date.UTC(year, month, 0);
}

/** The date a judgment is anchored to: the `decision_id` prefix. */
export function anchorDate(data) {
  return parseDate(String(data.decision_id ?? ''));
}

export function expectedLeakageRisk(asOf, cutoff = DEFAULT_CUTOFF) {
  const gap = daysBetween(cutoffBoundary(cutoff), asOf);
  if (gap <= 30) return 'high';
  if (gap <= 90) return 'medium';
  return 'low';
}

/** The minimum stop distance for a horizon: cumulative drift scales with √time. */
export function minStopWidth(atr, horizonDays) {
  return 1.5 * atr * Math.sqrt(horizonDays / 30);
}

export function checkReviewDue(data) {
  const anchor = anchorDate(data);
  const due = parseDate(data.review_due);
  if (anchor === null || due === null) return [];
  const expected = anchor + Number(data.horizon_days) * DAY_MS;
  if (due === expected) return [];
  const iso = new Date(expected).toISOString().slice(0, 10);
  return [
    finding(
      'review_due',
      'error',
      `review_due ${data.review_due}가 기준일 + horizon_days(${data.horizon_days})와 어긋난다. 기대값 ${iso}`,
    ),
  ];
}

export function checkStopWidth(data, { atr } = {}) {
  const stop = data.levels?.stop_loss;
  const reference = data.reference?.price;
  if (typeof stop !== 'number' || typeof reference !== 'number') return [];
  const width = Math.abs(stop - reference);
  const pct = (width / reference) * 100;
  const out = [];
  if (pct > STOP_CAP_PCT && data.verdict !== 'watch') {
    out.push(
      finding(
        'stop_cap',
        'error',
        `손절폭이 기준가의 ${pct.toFixed(1)}%로 ${STOP_CAP_PCT}%를 넘는다. verdict는 watch여야 한다`,
      ),
    );
  }
  if (typeof atr === 'number') {
    const required = minStopWidth(atr, Number(data.horizon_days));
    if (width < required) {
      out.push(
        finding(
          'stop_width',
          'error',
          `손절폭 ${width.toFixed(0)}원이 horizon ${data.horizon_days}일의 최소폭 ${required.toFixed(0)}원(${(required / atr).toFixed(2)} ATR)에 미달한다`,
        ),
      );
    }
  }
  return out;
}

export function checkLevelsPresent(data) {
  if (data.verdict !== 'buy' && data.verdict !== 'sell') return [];
  const missing = ['entry', 'stop_loss', 'targets'].filter((key) => data.levels?.[key] == null);
  if (missing.length === 0) return [];
  return [
    finding(
      'levels',
      'error',
      `verdict ${data.verdict}에는 levels가 필수다. 누락: ${missing.join(', ')}`,
    ),
  ];
}

export function checkInvalidation(data) {
  const items = data.invalidation ?? [];
  const out = [];
  if (items.length === 0) {
    return [
      finding('invalidation', 'error', 'invalidation이 비어 있다. 기한 없는 판단은 채점할 수 없다'),
    ];
  }
  const scales = items.map((item) => item.check_on).filter(Boolean);
  if (scales.length > 0 && scales.every((scale) => scale === 'daily')) {
    out.push(
      finding(
        'invalidation_scale',
        'error',
        `무효화 조건이 전부 check_on: daily다. horizon ${data.horizon_days}일에 상응하는 조건을 최소 하나 함께 둔다`,
      ),
    );
  }
  const uncheckable = items.filter((item) => item.checkable === false).length;
  if (uncheckable > 0) {
    out.push(
      finding(
        'invalidation_quality',
        'info',
        `checkable: false ${uncheckable}/${items.length}건 — 비율 자체가 조건 품질 지표다`,
      ),
    );
  }
  return out;
}

export function checkLeakageRisk(data, { cutoff = DEFAULT_CUTOFF } = {}) {
  if (data.provenance !== 'retro_seed') return [];
  const asOf = parseDate(data.retro_seed?.as_of);
  if (asOf === null) return [];
  const expected = expectedLeakageRisk(asOf, cutoff);
  const actual = data.retro_seed?.leakage_risk;
  if (actual === expected) return [];
  const gap = daysBetween(cutoffBoundary(cutoff), asOf);
  return [
    finding(
      'leakage_risk',
      'error',
      `leakage_risk가 ${actual}인데 as_of − 컷오프(${cutoff}) 간격 ${gap}일 기준으로는 ${expected}여야 한다`,
    ),
  ];
}

export const ALL_CHECKS = [
  checkReviewDue,
  checkStopWidth,
  checkLevelsPresent,
  checkInvalidation,
  checkLeakageRisk,
];

export function runRules(data, options = {}) {
  return ALL_CHECKS.flatMap((check) => check(data, options));
}
