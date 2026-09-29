/**
 * Linking trades (`transactions.csv`) to the judgments they acted on.
 *
 * A judgment's score says whether the call was right; it says nothing about
 * whether the user traded on it, or at what price. This module keeps the two
 * apart: `judgment` numbers come from the `scoring` block, `execution` numbers
 * from the fills, and neither is derived from the other.
 */

/** One CSV line, honouring double-quoted fields (`note` may hold commas). */
function splitLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Rows keyed by the header. A file written before `decision_id` existed has no
 * such column, and every row reads as unlinked rather than failing.
 */
export function parseTransactions(text) {
  // Excel and Numbers prefix a UTF-8 BOM, which would otherwise glue itself to `date`.
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const header = splitLine(lines[0]).map((name) => name.trim());
  return lines.slice(1).map((line, i) => {
    const cells = splitLine(line);
    const row = Object.fromEntries(header.map((name, j) => [name, (cells[j] ?? '').trim()]));
    return {
      line: i + 2,
      date: row.date.replaceAll('-', ''),
      symbol: row.symbol,
      side: row.side.toLowerCase(),
      quantity: Number(row.quantity),
      price: Number(row.price),
      fee: Number(row.fee || 0),
      decision_id: row.decision_id || null,
    };
  });
}

/** Which trade sides go with a verdict, and which go against it. */
const AGREES = { buy: ['buy'], sell: ['sell'] };
const OPPOSES = { buy: ['sell', 'watch'], sell: ['buy', 'hold'] };

/**
 * How one trade relates to the judgment it names. `neutral` covers the cases the
 * verdict does not speak to: adding under `hold`, trimming under `watch`.
 */
export function classify(trade, decision) {
  if (trade.decision_id === null) return 'unlinked';
  if (!decision) return 'unknown_decision';
  if (decision.symbol !== trade.symbol) return 'symbol_mismatch';
  const decided = String(decision.decided_at ?? '')
    .slice(0, 10)
    .replaceAll('-', '');
  if (trade.date < decided) return 'before_decision';
  if (AGREES[trade.side]?.includes(decision.verdict)) return 'followed';
  if (OPPOSES[trade.side]?.includes(decision.verdict)) return 'against';
  return 'neutral';
}

const round = (value) => (value === null ? null : Math.round(value * 100) / 100);
const pct = (from, to) => ((to - from) / from) * 100;

/** Quantity-weighted fill price with fees folded in: what a share actually cost or fetched. */
export function averageFill(trades) {
  const quantity = trades.reduce((sum, t) => sum + t.quantity, 0);
  if (quantity === 0) return null;
  const gross = trades.reduce((sum, t) => sum + t.quantity * t.price, 0);
  const fees = trades.reduce((sum, t) => sum + t.fee, 0);
  const side = trades[0].side;
  return (side === 'buy' ? gross + fees : gross - fees) / quantity;
}

/**
 * Execution numbers for one judgment's followed trades.
 *
 * `fill_gap_pct` is the fill against the judgment's reference price, signed so
 * that positive is worse for the position (paid more on a buy, got less on a sell).
 * `execution_return_pct` runs from the fill to `scoring.price_at_review` with the
 * same sign convention as `scoring.return_pct`, so the two sit in one table.
 */
export function executionOf(decision, trades) {
  const fill = averageFill(trades);
  if (fill === null) return null;
  const side = trades[0].side;
  const reference = Number(decision.reference?.price);
  const entry = decision.levels?.entry;
  const review = decision.scoring?.price_at_review;
  const buying = side === 'buy';
  const raw = typeof review === 'number' ? pct(fill, review) : null;
  return {
    side,
    quantity: trades.reduce((sum, t) => sum + t.quantity, 0),
    average_fill: round(fill),
    fill_gap_pct: Number.isFinite(reference)
      ? round(buying ? pct(reference, fill) : pct(fill, reference))
      : null,
    in_entry_range:
      entry && typeof entry.min === 'number' && typeof entry.max === 'number'
        ? trades.every((t) => t.price >= entry.min && t.price <= entry.max)
        : null,
    execution_return_pct: raw === null ? null : round(buying ? raw : -raw),
    judgment_return_pct: decision.scoring?.return_pct ?? null,
  };
}

const mean = (values) => {
  const numbers = values.filter((v) => typeof v === 'number');
  return numbers.length === 0 ? null : round(numbers.reduce((a, b) => a + b, 0) / numbers.length);
};

/**
 * The execution report: every trade classified, followed trades grouped per
 * judgment, and judgment vs execution performance side by side.
 */
export function linkTrades(trades, entries) {
  const decisions = new Map(
    entries.filter((entry) => entry.data).map((entry) => [entry.data.decision_id, entry.data]),
  );
  const classified = trades.map((trade) => ({
    ...trade,
    link: classify(trade, decisions.get(trade.decision_id)),
  }));

  const followed = new Map();
  for (const trade of classified.filter((t) => t.link === 'followed')) {
    const key = `${trade.decision_id}|${trade.side}`;
    if (!followed.has(key)) followed.set(key, []);
    followed.get(key).push(trade);
  }
  const byDecision = [...followed.values()].map((group) => ({
    decision_id: group[0].decision_id,
    verdict: decisions.get(group[0].decision_id).verdict,
    ...executionOf(decisions.get(group[0].decision_id), group),
  }));

  const counts = Object.fromEntries(
    [
      'followed',
      'against',
      'neutral',
      'unlinked',
      'before_decision',
      'symbol_mismatch',
      'unknown_decision',
    ].map((link) => [link, classified.filter((t) => t.link === link).length]),
  );
  const scored = byDecision.filter((row) => row.execution_return_pct !== null);

  return {
    counts,
    decisions: byDecision,
    performance: {
      n: scored.length,
      judgment_return_pct: mean(scored.map((row) => row.judgment_return_pct)),
      execution_return_pct: mean(scored.map((row) => row.execution_return_pct)),
      fill_gap_pct: mean(byDecision.map((row) => row.fill_gap_pct)),
    },
    problems: classified
      .filter((t) => ['symbol_mismatch', 'unknown_decision', 'before_decision'].includes(t.link))
      .map((t) => ({ line: t.line, decision_id: t.decision_id, link: t.link })),
  };
}
