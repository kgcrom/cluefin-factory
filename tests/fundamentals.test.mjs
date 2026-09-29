import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  indicatorValue,
  periodicReports,
  periodOf,
  withValues,
} from '../scripts/lib/fundamentals.mjs';
import { firstTrigger, scoreDecision } from '../scripts/lib/scoring.mjs';
import { reportsFor } from '../scripts/scorecard.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const series = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/series-383220.json'), 'utf8'));

// 125020의 2026-09-29 실제 disclosure-search 응답 모양. 사업보고서는 원본과 정정이 같은 날 접수됐다.
const DISCLOSURES = [
  { report_nm: '반기보고서 (2026.06)', rcept_no: '20260814002954', rcept_dt: '20260814' },
  { report_nm: '분기보고서 (2026.03)', rcept_no: '20260514001045', rcept_dt: '20260514' },
  {
    report_nm: '[기재정정]사업보고서 (2025.12)',
    rcept_no: '20260316001647',
    rcept_dt: '20260316',
  },
  { report_nm: '사업보고서 (2025.12)', rcept_no: '20260316001614', rcept_dt: '20260316' },
];

describe('정기보고서 식별', () => {
  it('제목의 (YYYY.MM)에서 사업연도와 보고서코드를 읽는다', () => {
    expect(periodOf('반기보고서 (2026.06)')).toEqual({ bsnsYear: '2026', reprtCode: '11012' });
    expect(periodOf('분기보고서 (2026.03)')).toEqual({ bsnsYear: '2026', reprtCode: '11013' });
    expect(periodOf('분기보고서 (2026.09)')).toEqual({ bsnsYear: '2026', reprtCode: '11014' });
    expect(periodOf('[기재정정]사업보고서 (2025.12)')).toEqual({
      bsnsYear: '2025',
      reprtCode: '11011',
    });
  });

  it('정기보고서가 아니면 null이다', () => {
    expect(periodOf('임원ㆍ주요주주특정증권등소유상황보고서')).toBeNull();
    expect(periodOf('분기보고서 (2026.05)')).toBeNull();
  });

  it('기간마다 가장 이른 접수일 하나만 남기고, 창 안의 것만 오래된 순으로 낸다', () => {
    const later = [
      ...DISCLOSURES,
      { report_nm: '[기재정정]반기보고서 (2026.06)', rcept_no: 'x', rcept_dt: '20260901' },
    ];
    expect(periodicReports(later, '20260401', '20260930')).toEqual([
      { bsnsYear: '2026', reprtCode: '11013', filedOn: '20260514' },
      { bsnsYear: '2026', reprtCode: '11012', filedOn: '20260814' },
    ]);
  });

  it('기준일 당일 접수분은 창에 넣지 않는다 — 판단이 이미 봤을 수 있다', () => {
    expect(periodicReports(DISCLOSURES, '20260514', '20260930').map((r) => r.filedOn)).toEqual([
      '20260814',
    ]);
  });
});

describe('지표 값', () => {
  const rows = [
    { idx_nm: 'ROE', idx_val: '9.194' },
    { idx_nm: '당좌비율', idx_val: null },
    { idx_nm: '자본금영업이익률', idx_val: '#########' },
  ];

  it('문자열 숫자를 숫자로 읽는다', () => {
    expect(indicatorValue(rows, 'ROE')).toBe(9.194);
  });

  it('null·자릿수 초과·없는 항목은 값이 아니다', () => {
    expect(indicatorValue(rows, '당좌비율')).toBeNull();
    expect(indicatorValue(rows, '자본금영업이익률')).toBeNull();
    expect(indicatorValue(rows, '부채비율')).toBeNull();
  });

  it('지표 분류마다 한 번만 조회한다', () => {
    const fetch = vi.fn(() => [
      { idx_nm: '영업이익증가율(YoY)', idx_val: '-3.5' },
      { idx_nm: '매출액증가율(YoY)', idx_val: '2' },
    ]);
    const [report] = withValues(
      [{ bsnsYear: '2026', reprtCode: '11012', filedOn: '20260814' }],
      ['operating_profit_growth_yoy', 'revenue_growth_yoy'],
      fetch,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report.values).toEqual({ operating_profit_growth_yoy: -3.5, revenue_growth_yoy: 2 });
  });
});

describe('재무 조건 발동', () => {
  const condition = {
    id: 'inv-1',
    statement: '영업이익 역성장',
    checkable: true,
    metric: 'operating_profit_growth_yoy',
    op: '<',
    value: 0,
    check_on: 'quarterly',
  };
  const report = (filedOn, value) => ({
    bsnsYear: '2026',
    reprtCode: '11012',
    filedOn,
    values: { operating_profit_growth_yoy: value },
  });

  it('보고서 접수 다음 거래일에 발동한다', () => {
    // 2026-08-14(금) 접수 → 08-15 광복절·주말을 건너 08-18(화)에 알려진다
    const { trigger, manual } = firstTrigger([condition], series.prices, '20260701', [
      report('20260814', -3.5),
    ]);
    expect(trigger).toEqual({ date: '20260818', ids: ['inv-1'] });
    expect(manual).toEqual([]);
  });

  it('조건을 만족하지 않으면 발동하지 않고, manual로도 넘기지 않는다', () => {
    const { trigger, manual } = firstTrigger([condition], series.prices, '20260701', [
      report('20260814', 12),
    ]);
    expect(trigger).toBeNull();
    expect(manual).toEqual([]);
  });

  it('값을 못 받은 보고서가 있으면 조용히 통과시키지 않고 manual로 넘긴다', () => {
    const { manual } = firstTrigger([condition], series.prices, '20260701', [
      report('20260814', null),
    ]);
    expect(manual).toEqual(['inv-1']);
  });

  it('맵에 없는 이름은 객체 기본 속성과 겹쳐도 manual이다', () => {
    const odd = { ...condition, metric: 'toString' };
    expect(firstTrigger([odd], series.prices, '20260701', []).manual).toEqual(['inv-1']);
  });

  it('보고서를 조회하지 않았으면(null) 예전처럼 manual이다', () => {
    expect(firstTrigger([condition], series.prices, '20260701').manual).toEqual(['inv-1']);
  });

  it('가격 조건과 재무 조건 중 먼저 발동한 쪽에서 끊는다', () => {
    const price = {
      id: 'inv-2',
      statement: '손절',
      checkable: true,
      metric: 'price',
      op: '<',
      value: 62000,
      check_on: 'daily',
    };
    // 가격은 08-03(61,800)에 먼저 깨진다
    const { trigger } = firstTrigger([condition, price], series.prices, '20260701', [
      report('20260814', -3.5),
    ]);
    expect(trigger).toEqual({ date: '20260803', ids: ['inv-2'] });
  });

  it('scoreDecision이 재무 발동일에서 조기 채점한다', () => {
    const data = {
      verdict: 'buy',
      horizon_days: 40,
      horizon_basis: 'trading',
      data_as_of: { price: '2026-07-24' },
      reference: { price: 76100 },
      invalidation: [condition],
    };
    const result = scoreDecision(data, {
      ...series,
      today: '20260919',
      reports: [report('20260814', -3.5)],
    });
    expect(result).toMatchObject({
      status: 'invalidated',
      endDate: '20260818',
      invalidated_by: ['inv-1'],
    });
  });
});

describe('reportsFor', () => {
  const fetchers = () => ({
    fetchCorpCode: vi.fn(() => '00381756'),
    fetchDisclosures: vi.fn(() => DISCLOSURES),
    fetchIndicators: vi.fn(() => [{ idx_nm: 'ROE', idx_val: '9.194' }]),
  });

  it('가격 조건뿐인 판단은 DART를 부르지 않는다', () => {
    const options = fetchers();
    const data = { invalidation: [{ id: 'inv-1', checkable: true, metric: 'price' }] };
    expect(reportsFor(data, '20260401', '20260930', options)).toBeNull();
    expect(options.fetchCorpCode).not.toHaveBeenCalled();
  });

  it('창 안에 접수된 보고서마다 필요한 지표를 붙인다', () => {
    const options = fetchers();
    const data = {
      symbol: '125020',
      invalidation: [{ id: 'inv-1', checkable: true, metric: 'roe', op: '<', value: 5 }],
    };
    const reports = reportsFor(data, '20260401', '20260930', options);
    expect(options.fetchDisclosures).toHaveBeenCalledWith('00381756', '20260401', '20260930');
    expect(options.fetchIndicators).toHaveBeenCalledWith(
      '00381756',
      expect.objectContaining({ bsnsYear: '2026', reprtCode: '11012' }),
      'M210000',
    );
    expect(reports.map((r) => [r.filedOn, r.values.roe])).toEqual([
      ['20260514', 9.194],
      ['20260814', 9.194],
    ]);
  });

  it('기업코드를 못 찾으면 null — 조건은 manual로 남는다', () => {
    const options = { ...fetchers(), fetchCorpCode: () => null };
    const data = { symbol: '999999', invalidation: [{ checkable: true, metric: 'roe' }] };
    expect(reportsFor(data, '20260401', '20260930', options)).toBeNull();
  });
});
