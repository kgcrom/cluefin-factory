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

describe('누수 위험 high 표본', () => {
  const seed = (asOf, extra = {}) =>
    decision({ retro_seed: { cohort: 'c1', as_of: asOf, ...extra } });
  const labels = (groups) => groups.map((g) => `${g.label}:${g.n}`).sort();

  it('high는 retro_seed에서 빠져 별도 그룹으로 나온다', () => {
    // 기본 컷오프 2026-05: 06-19는 19일(high), 08-18은 79일(medium)
    const groups = aggregate([seed('2026-06-19'), seed('2026-08-18')]);
    expect(labels(groups)).toEqual(['retro_seed:1', 'retro_seed_high_leakage:1']);
  });

  it('라벨이 아니라 as_of와 생성 모델의 컷오프로 분류한다', () => {
    // 옛 판단의 실제 모양: low로 적혔지만 Opus 5.5 컷오프(2026-06)에서 07-19는 19일
    const groups = aggregate([
      seed('2026-07-19', { leakage_risk: 'low', generator_model: 'claude-opus-5-5' }),
    ]);
    expect(labels(groups)).toEqual(['retro_seed_high_leakage:1']);
  });

  it('forward는 as_of가 없어 영향받지 않는다', () => {
    const groups = aggregate([decision({ provenance: 'forward', retro_seed: undefined })]);
    expect(labels(groups)).toEqual(['forward:1']);
  });

  it('cohort는 그룹을 나눈 뒤에 접는다', () => {
    // 같은 cohort라도 high와 medium이 한 표본으로 합쳐지면 안 된다
    const groups = aggregate([seed('2026-06-19'), seed('2026-08-18'), seed('2026-08-18')]);
    const retro = groups.find((g) => g.label === 'retro_seed');
    const high = groups.find((g) => g.label === 'retro_seed_high_leakage');
    expect([retro.n, retro.cohorts, high.n, high.cohorts]).toEqual([2, 1, 1, 1]);
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
