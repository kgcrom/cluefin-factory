/**
 * Aggregation over scored judgments.
 *
 * Retro seed and forward samples are never mixed, and a `cohort` is one sample,
 * not three: the same stock at 30/60/90 days overlaps, so counting each run
 * separately inflates the sample.
 */

const MIN_SAMPLE = 10;

const mean = (values) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
const round = (value) => (value === null ? null : Math.round(value * 100) / 100);

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  }
  return map;
}

function hitRate(rows) {
  const judged = rows.filter((row) => row.outcome === 'correct' || row.outcome === 'incorrect');
  if (judged.length === 0) return { n: 0, rate: null };
  const correct = judged.filter((row) => row.outcome === 'correct').length;
  return { n: judged.length, rate: round((correct / judged.length) * 100) };
}

/**
 * The excess a long position would have earned — one definition for every verdict.
 *
 * Deriving it from `return_pct` is not safe on its own: a `sell` stores that pair
 * already sign-flipped and a `watch` does not, so subtracting would put two sign
 * conventions in one column. Entries scored before `excess_long` became a field
 * fall back to undoing the `sell` flip by hand.
 */
function excessLong(data) {
  const scoring = data.scoring ?? {};
  if (typeof scoring.excess_long === 'number') return scoring.excess_long;
  if (typeof scoring.return_pct !== 'number' || typeof scoring.benchmark_return_pct !== 'number') {
    return null;
  }
  const raw = scoring.return_pct - scoring.benchmark_return_pct;
  return data.verdict === 'sell' ? -raw : raw;
}

/** One row per scored judgment, flattened from frontmatter. */
export function toRows(entries) {
  return entries
    .filter((entry) => ['scored', 'invalidated'].includes(entry.data?.scoring?.status))
    .map(({ data }) => ({
      decision_id: data.decision_id,
      provenance: data.provenance ?? 'forward',
      cohort: data.retro_seed?.cohort ?? data.decision_id,
      verdict: data.verdict,
      confidence: data.confidence,
      horizon_days: data.horizon_days,
      outcome: data.scoring.outcome,
      excess: excessLong(data),
      uncheckable: (data.invalidation ?? []).filter((item) => item.checkable === false).length,
      conditions: (data.invalidation ?? []).length,
    }));
}

/** Collapse each cohort to one entry so overlapping runs are not counted thrice. */
export function collapseCohorts(rows) {
  return [...groupBy(rows, (row) => row.cohort).values()].map((group) => {
    const correct = group.filter((row) => row.outcome === 'correct').length;
    return {
      ...group[0],
      members: group.length,
      outcome:
        correct * 2 === group.length
          ? 'inconclusive'
          : correct * 2 > group.length
            ? 'correct'
            : 'incorrect',
      excess: mean(group.map((row) => row.excess).filter((value) => value !== null)),
    };
  });
}

export function summarise(rows, label) {
  const byVerdict = [...groupBy(rows, (row) => row.verdict).entries()]
    .map(([verdict, group]) => ({
      verdict,
      ...hitRate(group),
      excess: round(mean(group.map((row) => row.excess).filter((value) => value !== null))),
    }))
    .sort((a, b) => a.verdict.localeCompare(b.verdict));

  const byConfidence = [...groupBy(rows, (row) => row.confidence).entries()]
    .map(([confidence, group]) => ({ confidence, ...hitRate(group) }))
    .sort((a, b) => a.confidence.localeCompare(b.confidence));

  const conditions = rows.reduce((sum, row) => sum + row.conditions, 0);
  const uncheckable = rows.reduce((sum, row) => sum + row.uncheckable, 0);

  return {
    label,
    n: rows.length,
    cohorts: collapseCohorts(rows).length,
    underpowered: rows.length < MIN_SAMPLE,
    overall: hitRate(rows),
    by_verdict: byVerdict,
    by_confidence: byConfidence,
    uncheckable_ratio: conditions === 0 ? null : round((uncheckable / conditions) * 100),
  };
}

export function aggregate(entries) {
  const rows = toRows(entries);
  const retro = rows.filter((row) => row.provenance === 'retro_seed');
  const forward = rows.filter((row) => row.provenance !== 'retro_seed');
  return [summarise(forward, 'forward'), summarise(retro, 'retro_seed')].filter(
    (group) => group.n > 0,
  );
}
