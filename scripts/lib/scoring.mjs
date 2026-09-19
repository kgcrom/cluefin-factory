/**
 * Scoring arithmetic. Every function here is pure and takes already-fetched
 * series, so the rules are testable without touching the network.
 *
 * Series shape: [{ date: 'YYYYMMDD', close, high, low }], ascending by date.
 */

const DAY_MS = 86_400_000;
const EARLY_EXIT_RATIO = 0.2;

export function toUtc(yyyymmdd) {
  return Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  );
}

export const compact = (isoDate) => isoDate.replaceAll('-', '');

export function elapsedDays(fromCompact, toCompact) {
  return Math.round((toUtc(toCompact) - toUtc(fromCompact)) / DAY_MS);
}

/** The last trading day of each ISO week — what `check_on: weekly` is measured on. */
export function weeklyCloses(series) {
  const byWeek = new Map();
  for (const row of series) {
    const date = new Date(toUtc(row.date));
    const thursday = new Date(date);
    thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
    const key = `${thursday.getUTCFullYear()}-${thursday.getUTCMonth()}-${thursday.getUTCDate()}`;
    byWeek.set(key, row);
  }
  return [...byWeek.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const COMPARATORS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

/**
 * First date an invalidation condition fires, scanning strictly after `afterDate`.
 * Only `checkable: true` price predicates are evaluated; anything else is returned
 * as `manual` for the skill to raise with the user.
 */
export function firstTrigger(invalidation, series, afterDate) {
  const manual = [];
  let earliest = null;
  for (const item of invalidation ?? []) {
    if (item.checkable !== true) {
      manual.push(item.id);
      continue;
    }
    const compare = COMPARATORS[item.op];
    if (!compare || item.metric !== 'price' || typeof item.value !== 'number') {
      manual.push(item.id);
      continue;
    }
    const rows = item.check_on === 'weekly' ? weeklyCloses(series) : series;
    const hit = rows.find((row) => row.date > afterDate && compare(row.close, item.value));
    if (!hit) continue;
    if (!earliest || hit.date < earliest.date) earliest = { date: hit.date, ids: [item.id] };
    else if (hit.date === earliest.date) earliest.ids.push(item.id);
  }
  return { trigger: earliest, manual };
}

export function slice(series, fromDate, toDate) {
  return series.filter((row) => row.date >= fromDate && row.date <= toDate);
}

export function pctChange(from, to) {
  return ((to - from) / from) * 100;
}

/** Population standard deviation of the index's daily returns over the window. */
export function dailyVolatility(indexSeries) {
  if (indexSeries.length < 3) return null;
  const returns = indexSeries.slice(1).map((row, i) => pctChange(indexSeries[i].close, row.close));
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

const LONG_VERDICTS = new Set(['buy', 'hold']);

/** `sell` and `watch` are judged on the inverse: not holding was the position. */
export function judgeOutcome(verdict, excessLong) {
  if (excessLong === null) return 'inconclusive';
  return LONG_VERDICTS.has(verdict) === excessLong > 0 ? 'correct' : 'incorrect';
}

export function scoreDecision(data, { prices, index, today }) {
  const referenceDate = compact(String(data.data_as_of?.price ?? ''));
  const reviewDue = compact(String(data.review_due ?? ''));
  const horizon = Number(data.horizon_days);
  const { trigger, manual } = firstTrigger(data.invalidation, prices, referenceDate);

  const due = reviewDue <= today;
  const earlyExit = trigger !== null && (!due || trigger.date < reviewDue);
  if (!due && !earlyExit) {
    // Not due and nothing fired: only the invalidation check applies, and it
    // came back clean. Scoring an open judgment early would invent a result.
    return { status: 'pending', manual_conditions: manual };
  }
  const endDate = earlyExit ? trigger.date : reviewDue;
  const window = slice(prices, referenceDate, endDate);
  if (window.length === 0) return { status: 'void', notes: '구간에 가격 데이터가 없다' };

  const reference = Number(data.reference?.price);
  const last = window.at(-1);
  const rawReturn = pctChange(reference, last.close);

  const indexWindow = slice(index, referenceDate, endDate);
  const benchmarkRaw =
    indexWindow.length >= 2 ? pctChange(indexWindow[0].close, indexWindow.at(-1).close) : null;
  const excessLong = benchmarkRaw === null ? null : rawReturn - benchmarkRaw;

  const verdict = data.verdict;
  const flip = verdict === 'sell';
  const elapsed = elapsedDays(referenceDate, endDate);
  const volatility = dailyVolatility(indexWindow);

  const stop = data.levels?.stop_loss;
  const targets = (data.levels?.targets ?? []).map((t) => t.price);
  const adverse = LONG_VERDICTS.has(verdict)
    ? Math.min(...window.map((r) => r.low))
    : Math.max(...window.map((r) => r.high));

  return {
    status: earlyExit ? 'invalidated' : 'scored',
    endDate,
    price_at_review: last.close,
    return_pct: round(flip ? -rawReturn : rawReturn),
    benchmark_return_pct: benchmarkRaw === null ? null : round(flip ? -benchmarkRaw : benchmarkRaw),
    excess_long: excessLong === null ? null : round(excessLong),
    max_drawdown_pct: round(pctChange(reference, adverse)),
    stop_hit: typeof stop === 'number' ? crossed(window, stop, LONG_VERDICTS.has(verdict)) : null,
    target_hit:
      targets.length > 0
        ? targets.some((target) => crossed(window, target, !LONG_VERDICTS.has(verdict)))
        : null,
    invalidated_by: earlyExit ? trigger.ids : [],
    manual_conditions: manual,
    outcome: judgeOutcome(verdict, excessLong),
    elapsed_days: elapsed,
    elapsed_ratio: round((elapsed / horizon) * 100),
    early_exit: elapsed / horizon < EARLY_EXIT_RATIO,
    index_volatility_pct: volatility === null ? null : round(volatility),
    within_noise: volatility !== null && excessLong !== null && Math.abs(excessLong) < volatility,
  };
}

const round = (value) => Math.round(value * 100) / 100;

/** Did intraday price reach `level`? Long positions break downward, shorts upward. */
function crossed(window, level, downward) {
  return downward
    ? window.some((row) => row.low <= level)
    : window.some((row) => row.high >= level);
}
