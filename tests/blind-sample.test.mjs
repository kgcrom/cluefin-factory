import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  drawCandidates,
  MIN_GAP_SESSIONS,
  verifyRegistry,
} from '../scripts/blind/sample.mjs';
import { isCommonShare, topByMarketCap } from '../scripts/blind/universe.mjs';
import { DAYS, fakeCli } from './helpers/fake-cluefin.mjs';

const summaries = {
  KOSPI: fakeCli(['kiwoom', 'stock', 'summary', '--market-type', '0']).list,
  KOSDAQ: fakeCli(['kiwoom', 'stock', 'summary', '--market-type', '10']).list,
};

describe('topByMarketCap', () => {
  it('보통주만, 두 시장을 한 줄로 시총순', () => {
    expect(topByMarketCap(summaries, 10).map((r) => [r.rank, r.symbol, r.market])).toEqual([
      [1, '005930', 'KOSPI'],
      [2, '247540', 'KOSDAQ'],
      [3, '000660', 'KOSPI'],
    ]);
  });

  it('우선주·ETF·스팩을 뺀다', () => {
    expect(isCommonShare({ code: '005935', upSizeName: '대형주' }, 'KOSPI')).toBe(false);
    expect(isCommonShare({ code: '069500', upSizeName: '' }, 'KOSPI')).toBe(false);
    expect(
      isCommonShare({ code: '400000', name: 'X스팩', kind: 'A', companyClassName: '' }, 'KOSDAQ'),
    ).toBe(false);
  });

  it('N에서 자른다', () => {
    expect(topByMarketCap(summaries, 2)).toHaveLength(2);
  });
});

const universe = [
  { symbol: '005930', name: '가', market: 'KOSPI' },
  { symbol: '000660', name: '나', market: 'KOSPI' },
  { symbol: '247540', name: '다', market: 'KOSDAQ' },
];
const draw = (seed) =>
  drawCandidates({ universe, calendar: DAYS, from: '20160104', to: '20240628', seed, count: 10 });

describe('drawCandidates', () => {
  it('같은 시드면 같은 목록, 다른 시드면 다른 목록', () => {
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  it('count × 3을 뽑고, as_of는 범위 안 거래일, horizon은 20/60/120', () => {
    const list = draw(7);
    expect(list).toHaveLength(30);
    for (const c of list) {
      expect(DAYS).toContain(c.as_of);
      expect(c.as_of >= '20160104' && c.as_of <= '20240628').toBe(true);
      expect([20, 60, 120]).toContain(c.horizon_days);
      expect(c.case_id).toMatch(/^[a-z]{12}$/);
    }
    expect(list.map((c) => c.order)).toEqual(list.map((_, i) => i + 1));
    expect(new Set(list.map((c) => c.case_id)).size).toBe(30);
  });

  it('같은 종목의 as_of는 120거래일 이상 떨어진다', () => {
    const list = draw(11);
    for (const a of list) {
      for (const b of list) {
        if (a === b || a.symbol !== b.symbol) continue;
        expect(Math.abs(DAYS.indexOf(a.as_of) - DAYS.indexOf(b.as_of))).toBeGreaterThanOrEqual(
          MIN_GAP_SESSIONS,
        );
      }
    }
  });

  it('벤치마크는 시장을 따른다', () => {
    for (const c of draw(3)) {
      expect(c.benchmark_code).toBe(c.market === 'KOSDAQ' ? '1001' : '2001');
    }
  });

  it('간격 규칙을 지킬 수 없으면 멈춘다', () => {
    expect(() =>
      drawCandidates({
        universe: universe.slice(0, 1),
        calendar: DAYS,
        from: '20240101',
        to: '20240628',
        seed: 1,
        count: 5,
      }),
    ).toThrow(/간격 규칙/);
  });
});

describe('registry', () => {
  const registry = createRegistry({
    name: 'test',
    universe,
    universeSource: 'fixture',
    calendar: DAYS,
    from: '20160104',
    to: '20240628',
    seed: 42,
    count: 4,
    createdAt: '2026-09-30T00:00:00Z',
  });

  it('후보 목록과 유니버스의 해시를 남긴다', () => {
    expect(registry.candidates_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.universe_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRegistry(registry)).toBe(registry);
  });

  it('사후 수정을 잡는다', () => {
    const edited = structuredClone(registry);
    edited.candidates[0].as_of = '20200102';
    expect(() => verifyRegistry(edited)).toThrow(/사후 수정/);
  });
});
