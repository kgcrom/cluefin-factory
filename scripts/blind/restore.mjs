/**
 * Turn a blind decision back into an ordinary, scoreable one.
 *
 * The isolated runner writes a `final-decision` frontmatter in case units: price
 * fields relative to D0 close = 100, no symbol, no dates. Restoring multiplies
 * every price-shaped field by `reference_price / 100` and fills identity and
 * dates from the seal. Stop-width and risk/reward rules are ratio-invariant, so
 * they hold the same in either unit.
 */
import { CASE_ID, sealHash } from './case.mjs';

const TRADING_DAYS_PER_WEEK = 5;
const CALENDAR_DAYS_PER_WEEK = 7;
const DAY_MS = 86_400_000;

export class RestoreError extends Error {}

const iso = (compact) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

/** as_of + horizon in calendar days — an estimate, as for any trading-basis judgment. */
function reviewDue(asOf, horizonDays) {
  const days = Math.round((horizonDays * CALENDAR_DAYS_PER_WEEK) / TRADING_DAYS_PER_WEEK);
  return new Date(Date.parse(`${iso(asOf)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * `blind`: the runner's frontmatter, carrying `blind.case_id`.
 * `seal`: the matching seal from `buildCase`.
 * Returns a new object; the input is not modified.
 */
export function restoreDecision(blind, seal, { generatorModel, seq = 1, decidedAt } = {}) {
  const caseId = blind?.blind?.case_id;
  if (!CASE_ID.test(caseId ?? '')) throw new RestoreError('blind.case_id가 없다');
  if (caseId !== seal.case_id) {
    throw new RestoreError(`case_id ${caseId} ≠ 봉인 ${seal.case_id}`);
  }
  if (blind.horizon_basis !== 'trading')
    throw new RestoreError('horizon_basis는 trading이어야 한다');
  if (Number(blind.horizon_days) !== seal.horizon_days) {
    throw new RestoreError(`horizon_days ${blind.horizon_days} ≠ 봉인 ${seal.horizon_days}`);
  }

  const factor = seal.reference_price / 100;
  const scale = (value) =>
    typeof value === 'number' ? Math.round(value * factor * 100) / 100 : value;
  const out = structuredClone(blind);

  out.decision_id = `${iso(seal.as_of)}-${seal.symbol}-${String(seq).padStart(2, '0')}`;
  // The runner cannot know today's date either; the restore time stands in for it.
  out.decided_at = decidedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  out.symbol = seal.symbol;
  out.name = seal.name;
  out.market = seal.market;
  // The runner cannot know any date, so whatever it wrote here is discarded.
  out.data_as_of = { price: iso(seal.as_of) };
  out.review_due = reviewDue(seal.as_of, seal.horizon_days);
  // D0 = 100 by construction; the real close is the seal's, not 100 × factor rounded.
  out.reference = { ...out.reference, price: seal.reference_price, adjusted: true };

  if (out.levels) {
    if (out.levels.entry) {
      out.levels.entry = { min: scale(out.levels.entry.min), max: scale(out.levels.entry.max) };
    }
    if ('stop_loss' in out.levels) out.levels.stop_loss = scale(out.levels.stop_loss);
    if (out.levels.targets) {
      out.levels.targets = out.levels.targets.map((target) => ({
        ...target,
        price: scale(target.price),
      }));
    }
  }
  out.invalidation = (out.invalidation ?? []).map((item) =>
    item.metric === 'price' ? { ...item, value: scale(item.value) } : item,
  );

  out.blind = {
    case_id: caseId,
    seal_sha256: sealHash(seal),
    generator_model: generatorModel ?? blind.blind.generator_model ?? null,
  };
  return out;
}
