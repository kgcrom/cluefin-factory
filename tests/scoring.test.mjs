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
  tradingDayAfter,
  tradingDaysBetween,
  weeklyCloses,
} from '../scripts/lib/scoring.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const series = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/series-383220.json'), 'utf8'));
const DECISIONS = join(ROOT, 'tests/fixtures/decisions');
const TODAY = '20260919';

const score = (file) =>
  scoreDecision(readEntry(join(DECISIONS, file)).data, { ...series, today: TODAY });

/**
 * Golden values: synthetic judgments over the 383220 series, each built so the
 * expected numbers can be read straight off the candles — the closes and index
 * levels used are in the comments. The script's output was checked against them,
 * not copied into them.
 */
describe('합성 판단 채점', () => {
  it('90일 buy — 일봉 손절선에 걸려 조기 종료되지만 지수보다 덜 빠졌다', () => {
    // 종가 77,600(07-10) → 74,400(07-20, 첫 75,000 하회), 지수 1196.69 → 1032.52
    expect(score('2026-07-10-383220-01.md')).toMatchObject({
      status: 'invalidated',
      endDate: '20260720',
      price_at_review: 74400,
      return_pct: -4.12,
      benchmark_return_pct: -13.72,
      excess_long: 9.59,
      invalidated_by: ['inv-2'],
      outcome: 'correct',
      horizon_basis: 'calendar',
      elapsed_days: 10,
      early_exit: true,
      stop_hit: true,
    });
  });

  it('40거래일 watch — 일봉이 아니라 주간 종가에서 발동, 관망이 옳았다', () => {
    // 08-03 종가 61,800이 먼저 70,000을 깨지만 주 마지막 거래일(08-07) 67,000에서만 본다.
    // 76,100 → 67,000, 지수 1055.58 → 974.73
    expect(score('2026-07-24-383220-01.md')).toMatchObject({
      status: 'invalidated',
      endDate: '20260807',
      price_at_review: 67000,
      return_pct: -11.96,
      benchmark_return_pct: -7.66,
      excess_long: -4.3,
      invalidated_by: ['inv-1'],
      outcome: 'correct',
      elapsed_days: 10,
      elapsed_calendar_days: 14,
      early_exit: false,
    });
  });

  it('20거래일 sell — 기한 완주, 방향이 틀렸다', () => {
    // 20거래일 뒤는 09-15. 64,900 → 67,300, 지수 1082.00 → 1042.46. sell은 부호가 반전된다.
    expect(score('2026-08-18-383220-01.md')).toMatchObject({
      status: 'scored',
      endDate: '20260915',
      price_at_review: 67300,
      return_pct: -3.7,
      benchmark_return_pct: 3.65,
      excess_long: 7.35,
      invalidated_by: [],
      manual_conditions: ['inv-2'],
      outcome: 'incorrect',
      elapsed_ratio: 100,
      // 09-01 고가 69,000이 손절선에 닿았지만 무효화는 주간 종가 조건이라 발동하지 않는다
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

describe('거래일 기준 horizon', () => {
  const base = readEntry(join(DECISIONS, '2026-07-10-383220-01.md')).data;

  it('경과를 달력일이 아니라 거래일로 센다', () => {
    // 2026-07-10(금) → 07-20(월): 달력 10일이지만 주말·07-17 휴장을 빼면 5거래일이다
    const result = scoreDecision(
      { ...base, horizon_basis: 'trading', horizon_days: 62 },
      { ...series, today: TODAY },
    );
    expect(result.elapsed_days).toBe(5);
    expect(result.elapsed_calendar_days).toBe(10);
    expect(result.horizon_basis).toBe('trading');
  });

  it('기한 도래를 review_due가 아니라 거래일 수로 판정한다', () => {
    const noTrigger = { ...base, invalidation: [], horizon_basis: 'trading' };
    // 20260710에서 3거래일 뒤는 20260715 — review_due(2026-10-08)와 무관하다
    expect(
      scoreDecision({ ...noTrigger, horizon_days: 3 }, { ...series, today: TODAY }).endDate,
    ).toBe('20260715');
    // 시계열이 닿지 않는 horizon은 아직 기한 미도래다
    expect(scoreDecision({ ...noTrigger, horizon_days: 500 }, { ...series, today: TODAY })).toEqual(
      {
        status: 'pending',
        manual_conditions: [],
      },
    );
  });

  it('horizon_basis가 없으면 예전처럼 달력일로 센다', () => {
    expect(score('2026-07-10-383220-01.md')).toMatchObject({
      horizon_basis: 'calendar',
      elapsed_days: 10,
    });
  });

  it('거래일 계산은 시계열에 있는 날만 센다', () => {
    expect(tradingDaysBetween(series.prices, '20260619', '20260623')).toBe(2);
    expect(tradingDayAfter(series.prices, '20260619', 2)).toBe('20260623');
    expect(tradingDayAfter(series.prices, '20260917', 1)).toBeNull();
  });
});

describe('잘린 시계열', () => {
  it('구간이 기준일까지 닿지 않으면 coverage_gap을 세운다', () => {
    const truncated = {
      prices: series.prices.filter((row) => row.date >= '20260713'),
      index: series.index,
    };
    const data = readEntry(join(DECISIONS, '2026-07-10-383220-01.md')).data;
    const result = scoreDecision(data, { ...truncated, today: TODAY });
    expect(result.coverage_gap).toBe(true);
  });

  it('온전한 구간이면 세우지 않는다', () => {
    expect(score('2026-07-10-383220-01.md').coverage_gap).toBe(false);
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
