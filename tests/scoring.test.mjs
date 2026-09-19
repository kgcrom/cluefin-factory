import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEntry } from '../scripts/lib/journal.mjs';
import {
  dailyVolatility,
  elapsedDays,
  firstTrigger,
  judgeOutcome,
  scoreDecision,
  weeklyCloses,
} from '../scripts/lib/scoring.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const series = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/series-383220.json'), 'utf8'));
const DECISIONS = join(ROOT, 'tests/fixtures/decisions');
const TODAY = '20260919';

const score = (file) =>
  scoreDecision(readEntry(join(DECISIONS, file)).data, { ...series, today: TODAY });

/**
 * Golden values: the three retro-seed judgments scored by hand on 2026-09-19,
 * before this module existed. If the arithmetic here drifts, these fail.
 *
 * The journal itself is git-ignored per-user data, so the three entries are
 * copied into fixtures — machine-generated retro seeds on a public ticker, with
 * no holdings or transactions in them.
 */
describe('2026-09-19 세션 채점 결과 재현', () => {
  it('90일 buy — 손절선에 걸려 4일 만에 조기 종료', () => {
    expect(score('2026-06-19-383220-02.md')).toMatchObject({
      status: 'invalidated',
      endDate: '20260623',
      price_at_review: 73200,
      return_pct: -9.96,
      benchmark_return_pct: -9.44,
      excess_long: -0.52,
      invalidated_by: ['inv-2'],
      outcome: 'incorrect',
      elapsed_days: 4,
      early_exit: true,
      within_noise: true,
    });
  });

  it('60일 watch — 볼린저 하단 이탈, 관망이 옳았다', () => {
    expect(score('2026-07-19-383220-02.md')).toMatchObject({
      status: 'invalidated',
      endDate: '20260803',
      price_at_review: 61800,
      return_pct: -21.77,
      benchmark_return_pct: -8.67,
      excess_long: -13.1,
      invalidated_by: ['inv-3'],
      outcome: 'correct',
      early_exit: false,
      within_noise: false,
    });
  });

  it('30일 sell — 기한 완주, 방향이 틀렸다', () => {
    expect(score('2026-08-18-383220-02.md')).toMatchObject({
      status: 'scored',
      endDate: '20260917',
      price_at_review: 68900,
      return_pct: -6.16,
      benchmark_return_pct: 2.19,
      excess_long: 8.36,
      invalidated_by: [],
      outcome: 'incorrect',
      elapsed_ratio: 100,
      stop_hit: true,
    });
  });
});

describe('채점 대상 선별', () => {
  const open = {
    decision_id: '2026-09-17-020000-01',
    verdict: 'watch',
    horizon_days: 90,
    review_due: '2026-12-16',
    data_as_of: { price: '2026-09-17' },
    reference: { price: 15890 },
    invalidation: [
      { id: 'inv-1', checkable: true, metric: 'price', op: '<', value: 14180, check_on: 'daily' },
      { id: 'inv-2', checkable: false },
    ],
  };

  it('기한 미도래 + 무효화 미발동이면 pending으로 남긴다', () => {
    const result = scoreDecision(open, { ...series, today: '20260919' });
    expect(result).toEqual({ status: 'pending', manual_conditions: ['inv-2'] });
  });

  it('기한 전이라도 무효화가 발동하면 그 시점에 조기 채점한다', () => {
    const fired = {
      ...open,
      data_as_of: { price: '2026-06-19' },
      reference: { price: 81300 },
      invalidation: [
        { id: 'inv-1', checkable: true, metric: 'price', op: '<', value: 73535, check_on: 'daily' },
      ],
    };
    const result = scoreDecision(fired, { ...series, today: '20260919' });
    expect(result).toMatchObject({ status: 'invalidated', endDate: '20260623' });
  });
});

describe('verdict별 판정 방향', () => {
  it('buy·hold는 초과수익이 양수일 때 맞다', () => {
    expect(judgeOutcome('buy', 1.2)).toBe('correct');
    expect(judgeOutcome('hold', -1.2)).toBe('incorrect');
  });

  it('sell·watch는 부등호가 반대다 — 피한 것이 옳았는지를 본다', () => {
    expect(judgeOutcome('sell', -1.2)).toBe('correct');
    expect(judgeOutcome('watch', 1.2)).toBe('incorrect');
  });

  it('벤치마크를 못 구하면 inconclusive다', () => {
    expect(judgeOutcome('buy', null)).toBe('inconclusive');
  });
});

describe('무효화 조건', () => {
  const prices = [
    { date: '20260101', close: 100, high: 100, low: 100 },
    { date: '20260102', close: 90, high: 95, low: 88 },
    { date: '20260105', close: 80, high: 85, low: 78 },
  ];

  it('가장 먼저 발동한 조건에서 끊는다', () => {
    const items = [
      { id: 'inv-1', checkable: true, metric: 'price', op: '<', value: 85, check_on: 'daily' },
      { id: 'inv-2', checkable: true, metric: 'price', op: '<', value: 95, check_on: 'daily' },
    ];
    expect(firstTrigger(items, prices, '20260101').trigger).toEqual({
      date: '20260102',
      ids: ['inv-2'],
    });
  });

  it('checkable: false와 술어로 못 쓰는 조건은 manual로 넘긴다', () => {
    const items = [
      { id: 'inv-1', checkable: false },
      { id: 'inv-2', checkable: true, metric: 'adx_14', op: '<', value: 20 },
    ];
    const { trigger, manual } = firstTrigger(items, prices, '20260101');
    expect(trigger).toBeNull();
    expect(manual).toEqual(['inv-1', 'inv-2']);
  });

  it('weekly 조건은 주 마지막 거래일 종가로만 본다', () => {
    const items = [
      { id: 'inv-1', checkable: true, metric: 'price', op: '<', value: 95, check_on: 'weekly' },
    ];
    // 20260102(금)가 그 주 마지막 거래일이라 주간 기준으로도 같은 날 발동한다
    expect(firstTrigger(items, prices, '20260101').trigger.date).toBe('20260102');
    expect(weeklyCloses(prices).map((r) => r.date)).toEqual(['20260102', '20260105']);
  });
});

describe('보조 계산', () => {
  it('경과일은 달력일 기준이다', () => {
    expect(elapsedDays('20260619', '20260623')).toBe(4);
    expect(elapsedDays('20260818', '20260917')).toBe(30);
  });

  it('구간 변동성은 지수 일간 수익률의 표준편차다', () => {
    expect(
      dailyVolatility(
        [{ close: 100 }, { close: 110 }, { close: 121 }].map((r, i) => ({
          date: `2026010${i + 1}`,
          ...r,
        })),
      ),
    ).toBeCloseTo(0, 6);
    expect(dailyVolatility([{ date: '1', close: 100 }])).toBeNull();
  });
});
