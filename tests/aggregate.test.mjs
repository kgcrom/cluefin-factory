import { describe, expect, it } from 'vitest';
import { aggregate, collapseCohorts, toRows } from '../scripts/lib/aggregate.mjs';

const decision = (overrides) => ({
  data: {
    decision_id: 'id',
    provenance: 'retro_seed',
    verdict: 'buy',
    confidence: 'medium',
    horizon_days: 30,
    retro_seed: { cohort: 'c1' },
    invalidation: [{ id: 'inv-1', checkable: true }],
    scoring: { status: 'scored', outcome: 'correct', return_pct: 5, benchmark_return_pct: 2 },
    ...overrides,
  },
});

describe('집계 대상', () => {
  it('채점이 끝난 건만 센다', () => {
    const rows = toRows([
      decision({}),
      decision({ scoring: { status: 'pending' } }),
      decision({ scoring: { status: 'invalidated', outcome: 'incorrect' } }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('retro seed와 forward를 같은 표에 넣지 않는다', () => {
    const groups = aggregate([
      decision({}),
      decision({ provenance: undefined, retro_seed: undefined }),
    ]);
    expect(groups.map((g) => g.label).sort()).toEqual(['forward', 'retro_seed']);
  });
});

describe('cohort', () => {
  it('같은 cohort 3건은 표본 1개로 접힌다', () => {
    const rows = toRows([decision({}), decision({}), decision({})]);
    expect(collapseCohorts(rows)).toHaveLength(1);
  });

  it('접힌 표본의 판정은 다수결이고 동수면 inconclusive다', () => {
    const rows = toRows([
      decision({}),
      decision({ scoring: { status: 'scored', outcome: 'incorrect' } }),
    ]);
    expect(collapseCohorts(rows)[0].outcome).toBe('inconclusive');
  });
});

describe('표본이 적으면 결론을 내지 않는다', () => {
  it('10건 미만이면 underpowered를 세운다', () => {
    const [group] = aggregate([decision({})]);
    expect(group).toMatchObject({ n: 1, underpowered: true });
  });
});

describe('지표', () => {
  it('적중률은 inconclusive를 분모에서 뺀다', () => {
    const [group] = aggregate([
      decision({}),
      decision({ scoring: { status: 'scored', outcome: 'inconclusive' } }),
    ]);
    expect(group.overall).toEqual({ n: 1, rate: 100 });
  });

  it('checkable: false 비율을 조건 품질 지표로 낸다', () => {
    const [group] = aggregate([
      decision({ invalidation: [{ checkable: true }, { checkable: false }] }),
    ]);
    expect(group.uncheckable_ratio).toBe(50);
  });
});

describe('초과수익 부호', () => {
  const scored = (verdict, scoring) =>
    decision({ verdict, decision_id: verdict, retro_seed: { cohort: verdict }, scoring });

  it('excess_long 필드가 있으면 그대로 읽는다', () => {
    const [row] = toRows([
      scored('sell', { status: 'scored', outcome: 'incorrect', excess_long: 8.36 }),
    ]);
    expect(row.excess).toBe(8.36);
  });

  it('필드가 없는 옛 기록은 sell의 부호 반전을 되돌린다', () => {
    // sell은 return_pct/benchmark가 이미 반전돼 저장돼 있다: 원값은 +8.36
    const [row] = toRows([
      scored('sell', {
        status: 'scored',
        outcome: 'incorrect',
        return_pct: -6.16,
        benchmark_return_pct: 2.19,
      }),
    ]);
    expect(row.excess).toBeCloseTo(8.35, 2);
  });

  it('watch는 반전 없이 그대로 쓴다', () => {
    const [row] = toRows([
      scored('watch', {
        status: 'invalidated',
        outcome: 'correct',
        return_pct: -21.77,
        benchmark_return_pct: -8.67,
      }),
    ]);
    expect(row.excess).toBeCloseTo(-13.1, 2);
  });
});
