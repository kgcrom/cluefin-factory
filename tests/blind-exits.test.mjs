import { describe, expect, it } from 'vitest';
import { describeExits, exitRuleFindings, expectedExits } from '../scripts/blind/exits.mjs';

const RULES = { stop_pct: 8, target_pct: 24 };
const price = (id, op, value) => ({
  id,
  statement: 's',
  checkable: true,
  metric: 'price',
  op,
  value,
  check_on: 'daily',
});
const buy = (overrides = {}) => ({
  verdict: 'buy',
  levels: { entry: { min: 99, max: 101 }, stop_loss: 92, targets: [{ price: 124, weight: 1 }] },
  invalidation: [
    price('inv-1', '<', 92),
    price('inv-2', '>=', 124),
    { id: 'inv-3', statement: 'x', checkable: false },
  ],
  ...overrides,
});

describe('expectedExits', () => {
  it('buy는 92/124, sell은 108/76, watch는 없음', () => {
    expect(expectedExits('buy', RULES)).toMatchObject({ stop_loss: 92, target: 124 });
    expect(expectedExits('hold', RULES)).toMatchObject({ stop_loss: 92, target: 124 });
    expect(expectedExits('sell', RULES)).toMatchObject({ stop_loss: 108, target: 76 });
    expect(expectedExits('watch', RULES)).toBeNull();
  });
});

describe('exitRuleFindings', () => {
  it('규칙대로면 빈 배열', () => {
    expect(exitRuleFindings(buy(), RULES)).toEqual([]);
  });

  it('손절·익절 수준이 다르면 잡는다', () => {
    const found = exitRuleFindings(
      buy({ levels: { stop_loss: 90, targets: [{ price: 115, weight: 1 }] } }),
      RULES,
    );
    expect(found.join(' ')).toMatch(/stop_loss는 92/);
    expect(found.join(' ')).toMatch(/price: 124/);
  });

  it('checkable 조건은 정확히 두 개 — 더 있거나 모자라면 잡는다', () => {
    const extra = buy({
      invalidation: [price('inv-1', '<', 92), price('inv-2', '>=', 124), price('inv-3', '<', 95)],
    });
    expect(exitRuleFindings(extra, RULES).join(' ')).toMatch(/정확히/);
    const missing = buy({ invalidation: [price('inv-1', '<', 92)] });
    expect(exitRuleFindings(missing, RULES).join(' ')).toMatch(/정확히/);
    const weekly = buy({
      invalidation: [price('inv-1', '<', 92), { ...price('inv-2', '>=', 124), check_on: 'weekly' }],
    });
    expect(exitRuleFindings(weekly, RULES).join(' ')).toMatch(/daily/);
  });

  it('sell은 뒤집힌 방향', () => {
    const sell = {
      verdict: 'sell',
      levels: { stop_loss: 108, targets: [{ price: 76, weight: 1 }] },
      invalidation: [price('inv-1', '>', 108), price('inv-2', '<=', 76)],
    };
    expect(exitRuleFindings(sell, RULES)).toEqual([]);
  });

  it('watch는 checkable 조건을 두지 않는다', () => {
    expect(
      exitRuleFindings(
        { verdict: 'watch', invalidation: [{ id: 'inv-1', statement: 's', checkable: false }] },
        RULES,
      ),
    ).toEqual([]);
    expect(
      exitRuleFindings({ verdict: 'watch', invalidation: [price('inv-1', '>=', 104)] }, RULES),
    ).toHaveLength(1);
  });

  it('판단기용 설명에 수준이 들어간다', () => {
    const text = describeExits(RULES);
    expect(text).toMatch(/손절 8%, 익절 24%/);
    expect(text).toMatch(/price < 92/);
    expect(text).toMatch(/price > 108/);
  });
});
