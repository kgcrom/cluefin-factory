import { describe, expect, it } from 'vitest';
import {
  consensus,
  holders,
  opinions,
  shareCount,
  tradingAverage,
} from '../scripts/company/market.mjs';

describe('consensus', () => {
  const row = (...values) => Object.fromEntries(values.map((v, i) => [`data${i + 1}`, String(v)]));

  it('행 순서로 항목을 붙이고, 금액 외 행은 10으로 나눈다', () => {
    const out = consensus({
      summary: { estdate: '20260812', rcmd_name: '매수' },
      periods: [{ dt: '2025.12' }, { dt: '2026.12E' }],
      data: [row(23988, 29957), row(107, 249), row(1958, 2529), row(116, 292), row(1231, 1725)],
      data_detail: [row(2699, 3376), row(108470, 152071), row(434, 402), row(150, 111)],
    });
    expect(out.estimatedOn).toBe('20260812');
    expect(out.years[1]).toMatchObject({
      period: '2026.12E',
      estimate: true,
      revenue: 29957,
      revenueGrowth: 24.9,
      netIncomeOwners: 1725,
      eps: 15207.1,
    });
    expect(out.years[0].estimate).toBe(false);
    expect(out.years[0]).not.toHaveProperty('per');
  });

  it('기간이 없으면 null', () => {
    expect(consensus({ periods: [] })).toBeNull();
  });
});

describe('opinions', () => {
  const op = (date, broker, target, rating = 'Buy') => ({
    stck_bsop_date: date,
    mbcr_name: broker,
    hts_goal_prc: String(target),
    invt_opnn: rating,
  });

  it('증권사마다 기간 안의 가장 최근 목표가만 쓴다', () => {
    const out = opinions(
      [
        op('20261007', 'A증권', 400000),
        op('20260901', 'A증권', 300000),
        op('20261001', 'B증권', 350000, 'BUY'),
        op('20260803', 'C증권', 250000, '매수'),
        op('20260601', 'D증권', 100000),
      ],
      '20260714',
    );
    expect(out.count).toBe(3);
    expect(out.mean).toBeCloseTo(333333.33, 1);
    expect(out.median).toBe(350000);
    expect(out.max).toEqual({ target: 400000, broker: 'A증권', date: '20261007' });
    expect(out.min.broker).toBe('C증권');
    expect(out.ratings).toEqual({ BUY: 2, 매수: 1 });
    expect(out.brokers.map((b) => b.broker)).toEqual(['A증권', 'B증권', 'C증권']);
  });

  it('기간 안에 의견이 없으면 count 0', () => {
    expect(opinions([], '20260714')).toEqual({ since: '20260714', count: 0, brokers: [] });
  });
});

describe('holders', () => {
  it('합계 행을 빼고 최대주주와 보통주 합을 낸다', () => {
    const row = (nm, relate, ratio, stock_knd = '보통주') => ({
      nm,
      relate,
      stock_knd,
      trmend_posesn_stock_qota_rt: ratio,
      stlm_dt: '2026-06-30',
    });
    const out = holders([
      row('임원1', '임원', '0.19'),
      row('모회사', '최대주주', '27.23'),
      row('계', null, '27.42'),
    ]);
    expect(out.largest).toEqual({ name: '모회사', ratio: 27.23 });
    expect(out.relatedTotal).toBeCloseTo(27.42);
    expect(out.top[0].name).toBe('모회사');
  });
});

describe('shareCount', () => {
  it('보통주 행의 발행·자기·유통 주식수', () => {
    expect(
      shareCount([
        { se: '우선주', istc_totqy: '-' },
        {
          se: '보통주',
          istc_totqy: '11,349,509',
          tesstk_co: '3,847',
          distb_stock_co: '11,345,662',
          stlm_dt: '2026-06-30',
        },
      ]),
    ).toEqual({ asOf: '2026-06-30', issued: 11349509, treasury: 3847, outstanding: 11345662 });
  });
});

describe('tradingAverage', () => {
  it('마지막 N개 봉의 평균, 모자라면 null', () => {
    const candles = Array.from({ length: 5 }, (_, i) => ({
      date: `2026100${i + 1}`,
      volume: i + 1,
      value: 10 * (i + 1),
    }));
    expect(tradingAverage(candles, 3)).toEqual({
      sessions: 3,
      from: '20261003',
      to: '20261005',
      volume: 4,
      value: 40,
    });
    expect(tradingAverage(candles, 6)).toBeNull();
  });
});
