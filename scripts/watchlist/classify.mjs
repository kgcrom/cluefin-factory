/**
 * Watchlist groups and the action that follows from them.
 *
 * Every number below was set by the 2025-02…2026-10 backtest; the § after a constant
 * points at the section of docs/watchlist-rules.md that holds its evidence. The numbers
 * live here only — the doc explains them, it does not restate a second copy to drift.
 *
 * Groups can overlap (a stock can be 2 and 3 at once). The action is
 * decided once, in this order: group 1 → exclude, group 3 → alert / watch, group 2 →
 * watch, nothing → exclude.
 */

export const RULES = {
  /** §2 공통: 하루 평균 거래대금(억원) 하한. 이보다 얇으면 체결·손절이 백테스트대로 안 된다. */
  minTradedValue: 10,
  /** §4 지수 대비 강도: 지수보다 강해야 한다 (원고의 "종목 RS > 지수 RS"). */
  relFloor: 1.0,
  /** §4 백분위 RS 90의 기간 중앙값. 넘으면 과열(1그룹) 쪽이다. */
  relCeiling: 1.32,
  /** §2 1그룹: 52주 고점 대비 하한(%). */
  g1MaxGap: -20,
  /** §2 1그룹: 이만큼 출렁이거나(10일 고저폭 %) 50일선에서 떨어져 있으면(%) 과열. */
  g1Range10: 15,
  g1DistMa50: 25,
  /** §2 2그룹: 52주 저점 대비 상승률(%) 구간 — Stage 2 초입. */
  g2FromLow: [30, 150],
  /** §3 3그룹 (수축 완료). */
  g3MinContractions: 3,
  g3MaxLastContraction: 10,
  g3MaxRange10: 12,
  g3MaxGap: -20,
  /** §3 백테스트 셋업은 종가가 피봇 아래 8% 안일 때만 잡았다. */
  g3MaxBelowPivot: -8,
  /** §6 주문. */
  alertBelowPivot: 0.03,
  chaseLimit: 0.05,
  stopLoss: 0.08,
  takeProfit: 0.24,
  /** §5 2그룹 점수가 이 이상이면 3그룹 후보. */
  g2CandidateScore: 6,
};

/** KRX tick size (one table for KOSPI and KOSDAQ since 2023-01-25). */
export function tickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/** Round down to a valid quote. */
export function floorToTick(price) {
  const tick = tickSize(price);
  return Math.floor(price / tick) * tick;
}

const check = (rule, value, pass) => ({ rule, value, pass: Boolean(pass) });
const allPass = (checks) => checks.every((c) => c.pass);

/** §5: seven conditions that made a group-2 stock more likely to become a group-3 breakout. */
export function g2Score(f, s) {
  const items = [
    check('10일 고저폭 ≤ 12%', f.range10, f.range10 <= 12),
    check('ATR14 ≤ 4.5%', f.atr14p, f.atr14p <= 4.5),
    check('60일 깊이 ≤ 30%', f.depth60, f.depth60 <= 30),
    check('50일선 이격 ≤ 10%', f.distMa50, f.distMa50 <= 10),
    check('지수 대비 21일 초과수익 ≤ 5.5%p', s.ex21, s.ex21 <= 5.5),
    check('52주 저점 대비 ≤ 100%', f.from52l, f.from52l <= 100),
    check('52주 고점 −15% 이내', f.gap52h, f.gap52h >= -15),
  ];
  const score = items.filter((i) => i.pass).length;
  return { score, of: items.length, candidate: score >= RULES.g2CandidateScore, items };
}

/** §6: alert, buy stop, chase limit, stop loss and the 3R target, all on valid ticks. */
export function orders(pivotPrice) {
  return {
    alert: floorToTick(pivotPrice * (1 - RULES.alertBelowPivot)),
    buyStop: pivotPrice,
    chaseLimit: floorToTick(pivotPrice * (1 + RULES.chaseLimit)),
    stopLoss: floorToTick(pivotPrice * (1 - RULES.stopLoss)),
    takeProfit: floorToTick(pivotPrice * (1 + RULES.takeProfit)),
  };
}

/**
 * `f` from features(), `pv` from pivot() (may be null), `s` from strength().
 * Returns the groups, the per-rule checks behind them, and one action.
 */
export function classify(f, pv, s) {
  const toPivot = pv ? (f.close / pv.price - 1) * 100 : null;
  const liquid = check(
    `거래대금 ≥ ${RULES.minTradedValue}억`,
    f.tv20,
    f.tv20 >= RULES.minTradedValue,
  );

  const g1 = [
    check(`지수 대비 ≥ ${RULES.relCeiling}`, s.rel, s.rel >= RULES.relCeiling),
    check(`52주 고점 ${RULES.g1MaxGap}% 이내`, f.gap52h, f.gap52h >= RULES.g1MaxGap),
    check(
      `10일 고저폭 > ${RULES.g1Range10}% 또는 50일선 이격 > ${RULES.g1DistMa50}%`,
      { range10: f.range10, distMa50: f.distMa50 },
      f.range10 > RULES.g1Range10 || f.distMa50 > RULES.g1DistMa50,
    ),
  ];
  const [lo, hi] = RULES.g2FromLow;
  const g2 = [
    check('정배열(트렌드 템플릿)', f.tt, f.tt),
    check(`52주 저점 대비 ${lo}~${hi}%`, f.from52l, f.from52l >= lo && f.from52l <= hi),
    check(`지수 대비 > ${RULES.relFloor}`, s.rel, s.rel > RULES.relFloor),
  ];
  const g3 = [
    liquid,
    check(
      `수축 ≥ ${RULES.g3MinContractions}회`,
      pv?.contractions ?? 0,
      (pv?.contractions ?? 0) >= RULES.g3MinContractions,
    ),
    check(
      `마지막 수축 ≤ ${RULES.g3MaxLastContraction}%`,
      pv?.lastContraction ?? null,
      pv !== null && pv.lastContraction <= RULES.g3MaxLastContraction,
    ),
    check(`10일 고저폭 ≤ ${RULES.g3MaxRange10}%`, f.range10, f.range10 <= RULES.g3MaxRange10),
    check(`52주 고점 ${RULES.g3MaxGap}% 이내`, f.gap52h, f.gap52h >= RULES.g3MaxGap),
    check(
      `지수 대비 ${RULES.relFloor} 초과 ${RULES.relCeiling} 미만`,
      s.rel,
      s.rel > RULES.relFloor && s.rel < RULES.relCeiling,
    ),
  ];
  const groups = { g1: allPass(g1), g2: allPass(g2), g3: allPass(g3) };

  const result = {
    groups,
    checks: { g1, g2, g3 },
    g2Score: g2Score(f, s),
    pivot: pv && { ...pv, toPivot },
    orders: pv && orders(pv.price),
  };
  return { ...result, ...decide(groups, { liquid, toPivot, g2Score: result.g2Score }) };
}

function decide(groups, { liquid, toPivot, g2Score: score }) {
  if (!liquid.pass) {
    return { action: 'exclude', status: 'illiquid', reason: '거래대금이 얇아 백테스트 대상 밖' };
  }
  if (groups.g1) {
    return {
      action: 'exclude',
      status: 'overheated',
      reason: '1그룹(과열) — 이 자리 돌파는 우위가 없었다',
    };
  }
  if (groups.g3) {
    if (toPivot >= RULES.chaseLimit * 100) {
      return { action: 'watch', status: 'extended', reason: '피봇 +5% 초과 — 추격 금지' };
    }
    // A close exactly on the pivot has not broken out; the buy stop is still the next step.
    if (toPivot > 0) {
      return {
        action: 'watch',
        status: 'breaking_out',
        reason: '이미 피봇 위(추격 한도 안) — 백테스트는 피봇 아래에서 셋업을 잡았다',
      };
    }
    if (toPivot < RULES.g3MaxBelowPivot) {
      return { action: 'watch', status: 'far_below_pivot', reason: '피봇에서 8% 넘게 아래' };
    }
    return {
      action: 'alert',
      status: 'setup',
      reason: '3그룹 — 피봇 아래 알림, 피봇에서 매수 스톱',
    };
  }
  if (groups.g2) {
    return score.candidate
      ? { action: 'watch', status: 'g3_candidate', reason: '2그룹 — 점수가 높아 3그룹 후보' }
      : { action: 'watch', status: 'g2', reason: '2그룹 — 수축을 기다린다' };
  }
  return { action: 'exclude', status: 'no_group', reason: '어느 그룹 조건도 채우지 못함' };
}
