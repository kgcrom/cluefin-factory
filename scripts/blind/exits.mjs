/**
 * Fixed exit rules for a blind run: every position uses the same stop and
 * take-profit distance from D0 (= 100 in case units), so runs differ only in
 * the judge's direction call, not in how it sized exits.
 *
 * With `{ stop_pct: 8, target_pct: 24 }`:
 *   buy / hold  stop_loss 92,  target 124, checkable conditions exactly
 *               close < 92 (daily) and close >= 124 (daily)
 *   sell        stop_loss 108, target 76,  close > 108 and close <= 76
 *   watch       no levels, no checkable condition — it runs to the horizon,
 *               because "not holding" has no price at which it is stopped out
 *
 * Scoring already ends a judgment on the first checkable condition that fires,
 * at that day's close, so the take-profit is a condition like the stop.
 */

const round2 = (value) => Math.round(value * 100) / 100;

/** The levels and conditions a verdict must carry under `rules`, in case units. */
export function expectedExits(verdict, { stop_pct: stop, target_pct: target }) {
  if (verdict === 'watch') return null;
  const long = verdict !== 'sell';
  const stopLevel = round2(long ? 100 - stop : 100 + stop);
  const targetLevel = round2(long ? 100 + target : 100 - target);
  return {
    stop_loss: stopLevel,
    target: targetLevel,
    conditions: long
      ? [
          { op: '<', value: stopLevel },
          { op: '>=', value: targetLevel },
        ]
      : [
          { op: '>', value: stopLevel },
          { op: '<=', value: targetLevel },
        ],
  };
}

const conditionKey = (item) => `${item.op} ${round2(Number(item.value))}`;

/** Messages for every way a blind decision breaks the run's exit rules; empty when it holds. */
export function exitRuleFindings(data, rules) {
  const findings = [];
  const checkable = (data.invalidation ?? []).filter((item) => item.checkable === true);
  const expected = expectedExits(data.verdict, rules);

  if (expected === null) {
    if (checkable.length > 0) {
      findings.push(
        'watch는 checkable: true 조건을 두지 않는다 — 기한까지 간다(모두 checkable: false로)',
      );
    }
    return findings;
  }

  const levels = data.levels ?? {};
  if (round2(Number(levels.stop_loss)) !== expected.stop_loss) {
    findings.push(`levels.stop_loss는 ${expected.stop_loss}이어야 한다 (현재 ${levels.stop_loss})`);
  }
  const targets = levels.targets ?? [];
  if (
    targets.length !== 1 ||
    round2(Number(targets[0].price)) !== expected.target ||
    targets[0].weight !== 1
  ) {
    findings.push(`levels.targets는 [{ price: ${expected.target}, weight: 1 }] 하나여야 한다`);
  }

  const wrongShape = checkable.filter(
    (item) => item.metric !== 'price' || item.check_on !== 'daily',
  );
  if (wrongShape.length > 0) {
    findings.push(
      `checkable 조건은 metric: price, check_on: daily만 쓴다 (${wrongShape.map((i) => i.id).join(', ')})`,
    );
  }
  const have = checkable.map(conditionKey).sort();
  const want = expected.conditions.map(conditionKey).sort();
  if (have.join('|') !== want.join('|')) {
    findings.push(
      `checkable 조건은 정확히 [${want.join(', ')}] 두 개여야 한다 (현재 [${have.join(', ')}]) — 나머지는 checkable: false로`,
    );
  }
  return findings;
}

/** The rules as the judge reads them in its prompt. */
export function describeExits(rules) {
  const long = expectedExits('buy', rules);
  const short = expectedExits('sell', rules);
  return [
    `이 실행은 고정 청산 규칙을 쓴다: 손절 ${rules.stop_pct}%, 익절 ${rules.target_pct}%.`,
    'final-decision의 손절폭 규칙(1.5 × ATR14 × √(horizon/30))과 20% 초과 시 watch 규칙 대신 이것을 따른다.',
    `- buy/hold: levels.stop_loss ${long.stop_loss}, targets [{ price: ${long.target}, weight: 1 }], checkable 조건은 정확히 두 개 — price < ${long.stop_loss} (daily), price >= ${long.target} (daily).`,
    `- sell: levels.stop_loss ${short.stop_loss}, targets [{ price: ${short.target}, weight: 1 }], checkable 조건은 price > ${short.stop_loss} (daily), price <= ${short.target} (daily).`,
    '- watch: levels 없음, checkable: true 조건 없음(재검토 조건은 checkable: false로) — 기한까지 간다.',
    '- 그 밖의 무효화 조건은 모두 checkable: false로 statement에만 적는다.',
    '청산 구간이 정해져 있으니, 판단은 방향(buy/sell/hold/watch)과 확신도에 집중한다.',
  ].join('\n');
}
