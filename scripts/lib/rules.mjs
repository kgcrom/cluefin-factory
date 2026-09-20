/**
 * Rule checks that `final-decision` states in prose. Each one is a pure function
 * over parsed frontmatter so the rule lives here, not in two places.
 *
 * Severities: `error` fails the lint, `warn` and `info` only report.
 */

const DAY_MS = 86_400_000;
const STOP_CAP_PCT = 20;

/**
 * A model's training cutoff, which is what `leakage_risk` is measured from.
 *
 * This is a FACT about each model, not a policy dial, so it must not be derived
 * from the calendar (`now - N days`): the calendar moves and the cutoff does not,
 * so a relative boundary silently slides `as_of` into the region the model
 * already knows. Add an entry only after confirming that model's documented
 * cutoff — an unknown model is an error, never a guess.
 */
export const MODEL_CUTOFFS = {
  'claude-opus-5': '2026-05',
};

export const DEFAULT_CUTOFF = '2026-05';

/** Retro seed horizons, in trading days. Longer rungs are forward-only. */
export const HORIZON_LADDER = [20, 40, 60];

const TRADING_DAYS_PER_WEEK = 5;
const CALENDAR_DAYS_PER_WEEK = 7;

/** The lowest gap that is not `high`: anything closer is refused outright. */
const MEDIUM_FLOOR_DAYS = 31;

const finding = (rule, severity, message) => ({ rule, severity, message });

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Today as UTC midnight. `--today` arrives compact; a bare call means now. */
function todayMs(today) {
  const parsed = parseDate(today);
  if (parsed !== null) return parsed;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Calendar days a horizon spans, so an end date can be estimated up front. */
export function calendarSpan(horizonDays, basis) {
  const days = Number(horizonDays);
  if (!Number.isFinite(days)) return null;
  return basis === 'trading'
    ? Math.round((days * CALENDAR_DAYS_PER_WEEK) / TRADING_DAYS_PER_WEEK)
    : days;
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
  if (data.horizon_basis === 'trading') {
    // Future holidays are unknown, so review_due is an estimate and the real
    // completion date is counted at scoring time. Only flag an implausible one.
    const nominal = (Number(data.horizon_days) * CALENDAR_DAYS_PER_WEEK) / TRADING_DAYS_PER_WEEK;
    const gap = daysBetween(anchor, due);
    if (gap < nominal * 0.8 || gap > nominal * 1.4) {
      return [
        finding(
          'review_due',
          'warn',
          `review_due가 기준일 + ${gap}일인데, 거래일 ${data.horizon_days}일은 달력으로 ${Math.round(nominal)}일 안팎이다`,
        ),
      ];
    }
    return [];
  }
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

/**
 * Which cutoff applies to a judgment: the one belonging to the model that wrote
 * it, falling back to the run-wide default when the file does not say.
 */
export function cutoffForModel(model, fallback = DEFAULT_CUTOFF) {
  if (typeof model !== 'string') return fallback;
  return MODEL_CUTOFFS[model] ?? fallback;
}

/**
 * The widest retro seed horizon the current cutoff still affords.
 *
 * `as_of` has to clear the `high` band on one side and leave room for the whole
 * horizon to finish on the other, and both eat the same span. Returns the budget
 * in calendar days and the trading-day horizon it converts to.
 */
export function retroSeedBudget(cutoff = DEFAULT_CUTOFF, today = undefined) {
  const calendar = daysBetween(cutoffBoundary(cutoff) + MEDIUM_FLOOR_DAYS * DAY_MS, todayMs(today));
  return {
    calendar,
    trading: Math.floor((calendar * TRADING_DAYS_PER_WEEK) / CALENDAR_DAYS_PER_WEEK),
  };
}

export function checkGeneratorModel(data) {
  if (data.provenance !== 'retro_seed') return [];
  const model = data.retro_seed?.generator_model;
  if (model === undefined) {
    return [
      finding(
        'generator_model',
        'warn',
        `retro_seed.generator_model이 없어 기본 컷오프(${DEFAULT_CUTOFF})로 채점한다. 모델을 바꾸면 이 판단의 leakage_risk는 다시 매겨야 한다`,
      ),
    ];
  }
  if (!(model in MODEL_CUTOFFS)) {
    return [
      finding(
        'generator_model',
        'error',
        `generator_model ${model}의 학습 컷오프를 모른다. rules.mjs의 MODEL_CUTOFFS에 확인된 값을 등록한다 — 추측하지 않는다`,
      ),
    ];
  }
  return [];
}

export function checkLeakageRisk(data, { cutoff = DEFAULT_CUTOFF } = {}) {
  if (data.provenance !== 'retro_seed') return [];
  const asOf = parseDate(data.retro_seed?.as_of);
  if (asOf === null) return [];
  const applied = cutoffForModel(data.retro_seed?.generator_model, cutoff);
  const expected = expectedLeakageRisk(asOf, applied);
  const actual = data.retro_seed?.leakage_risk;
  if (actual === expected) return [];
  const gap = daysBetween(cutoffBoundary(applied), asOf);
  return [
    finding(
      'leakage_risk',
      'error',
      `leakage_risk가 ${actual}인데 as_of − 컷오프(${applied}) 간격 ${gap}일 기준으로는 ${expected}여야 한다`,
    ),
  ];
}

/**
 * The two ways a retro seed can be unbuildable, both refused before it is scored.
 *
 * `high` is refused because the cutoff is a soft boundary and the region next to
 * it is where memory and skill are least separable. An unfinished horizon is
 * refused because a retro seed exists to be scored immediately — one that has to
 * wait is a forward judgment wearing the wrong label.
 */
export function checkRetroSeedBudget(data, { cutoff = DEFAULT_CUTOFF, today } = {}) {
  if (data.provenance !== 'retro_seed') return [];
  const asOf = parseDate(data.retro_seed?.as_of);
  if (asOf === null) return [];
  const applied = cutoffForModel(data.retro_seed?.generator_model, cutoff);
  const budget = retroSeedBudget(applied, today);
  const out = [];

  if (expectedLeakageRisk(asOf, applied) === 'high') {
    const earliest = new Date(cutoffBoundary(applied) + MEDIUM_FLOOR_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    out.push(
      finding(
        'retro_seed_budget',
        'error',
        `as_of ${data.retro_seed.as_of}는 컷오프(${applied}) 경계에서 30일 이내라 leakage_risk가 high다. retro seed는 ${earliest} 이후 as_of로만 만든다`,
      ),
    );
  }

  const span = calendarSpan(data.horizon_days, data.horizon_basis);
  if (span !== null && asOf + span * DAY_MS > todayMs(today)) {
    const unit = data.horizon_basis === 'trading' ? '거래일' : '일';
    out.push(
      finding(
        'retro_seed_budget',
        'error',
        `as_of + ${data.horizon_days}${unit}(달력 ${span}일)이 오늘을 넘어 채점할 수 없다. 현재 컷오프 예산은 거래일 ${budget.trading}일이며, 이를 넘는 horizon은 forward로 발행한다`,
      ),
    );
  }
  return out;
}

/**
 * The rungs retro seed is defined on. Off-ladder horizons still score, so this
 * only warns — but a sample built off the ladder is not comparable with the rest.
 */
export function checkHorizonLadder(data) {
  if (data.provenance !== 'retro_seed') return [];
  const out = [];
  if (data.horizon_basis !== 'trading') {
    out.push(
      finding(
        'horizon_ladder',
        'warn',
        'retro seed는 거래일 기준으로 센다. horizon_basis: trading을 지정한다',
      ),
    );
  }
  if (!HORIZON_LADDER.includes(Number(data.horizon_days))) {
    out.push(
      finding(
        'horizon_ladder',
        'warn',
        `horizon_days ${data.horizon_days}가 사다리 ${HORIZON_LADDER.join('/')}(거래일) 밖이다. 다른 표본과 나란히 비교할 수 없다`,
      ),
    );
  }
  return out;
}

export const ALL_CHECKS = [
  checkReviewDue,
  checkStopWidth,
  checkLevelsPresent,
  checkInvalidation,
  checkGeneratorModel,
  checkLeakageRisk,
  checkRetroSeedBudget,
  checkHorizonLadder,
];

export function runRules(data, options = {}) {
  return ALL_CHECKS.flatMap((check) => check(data, options));
}
