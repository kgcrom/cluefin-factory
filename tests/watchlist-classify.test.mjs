import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classify,
  floorToTick,
  g2Score,
  orders,
  tickSize,
} from '../scripts/watchlist/classify.mjs';
import { features } from '../scripts/watchlist/features.mjs';
import { pivot } from '../scripts/watchlist/pivot.mjs';
import { strength } from '../scripts/watchlist/strength.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const load = (name) =>
  JSON.parse(readFileSync(join(ROOT, `tests/fixtures/${name}-20261006.json`), 'utf8'));
const INDEX = { KOSPI: load('watchlist-index-0001'), KOSDAQ: load('watchlist-index-1001') };

function classifyFixture(symbol) {
  const { candles, market } = load(`watchlist-${symbol}`);
  return classify(features(candles), pivot(candles), strength(candles, INDEX[market].closes));
}

const failed = (checks) => checks.filter((c) => !c.pass).map((c) => c.rule);

describe('classify — 10-06 종가 실제 종목', () => {
  it('롯데렌탈: 종가가 피봇과 같다 → 알림 (2·3그룹)', () => {
    const got = classifyFixture('089860');
    expect(got.groups).toEqual({ g1: false, g2: true, g3: true });
    expect(got.pivot.toPivot).toBe(0);
    expect(got.action).toBe('alert');
  });

  it('현대해상: 피봇 −7.5% → 알림', () => {
    const got = classifyFixture('001450');
    expect(got.groups.g3).toBe(true);
    expect(got.action).toBe('alert');
    expect(got.status).toBe('setup');
  });

  it('KT&G: 수축은 갖췄지만 코스피보다 약해(0.81) 제외', () => {
    const got = classifyFixture('033780');
    expect(failed(got.checks.g3)).toEqual(['지수 대비 1 초과 1.32 미만']);
    expect(got.groups).toEqual({ g1: false, g2: false, g3: false });
    expect(got.action).toBe('exclude');
    expect(got.orders.buyStop).toBe(179700);
  });

  it('팬오션: 코스피보다 약해(0.97) 제외', () => {
    expect(classifyFixture('028670').action).toBe('exclude');
  });

  it('엑시콘: 1그룹(과열) → 제외', () => {
    const got = classifyFixture('092870');
    expect(got.groups.g1).toBe(true);
    expect(got.status).toBe('overheated');
  });

  it('DMS: 하루 평균 거래대금 3.8억 → 유동성 미달로 제외', () => {
    const got = classifyFixture('068790');
    expect(got.status).toBe('illiquid');
  });
});

// 3그룹을 모두 통과하는 기준 상태. 피봇 10,000, 종가 −3%.
const F = {
  close: 9700,
  tv20: 50,
  gap52h: -10,
  from52l: 80,
  tt: true,
  range10: 8,
  distMa50: 5,
  atr14p: 3,
  depth60: 20,
};
const PV = { price: 10000, contractions: 3, lastContraction: 6 };
const S = { rel: 1.1, ex21: 0 };
const run = ({ f = {}, pv = {}, s = {} } = {}) =>
  classify({ ...F, ...f }, pv === null ? null : { ...PV, ...pv }, { ...S, ...s });

describe('classify — 경계값', () => {
  it('기준 상태는 2·3그룹, 알림', () => {
    const got = run();
    expect(got.groups).toEqual({ g1: false, g2: true, g3: true });
    expect(got.action).toBe('alert');
  });

  it('지수 대비는 1 초과 1.32 미만이어야 3그룹', () => {
    expect(run({ s: { rel: 1.0 } }).groups.g3).toBe(false);
    expect(run({ s: { rel: 1.0001 } }).groups.g3).toBe(true);
    expect(run({ s: { rel: 1.3199 } }).groups.g3).toBe(true);
    expect(run({ s: { rel: 1.32 } }).groups.g3).toBe(false);
  });

  it('마지막 수축 10%까지, 수축 3회부터', () => {
    expect(run({ pv: { lastContraction: 10 } }).groups.g3).toBe(true);
    expect(run({ pv: { lastContraction: 10.01 } }).groups.g3).toBe(false);
    expect(run({ pv: { contractions: 2 } }).groups.g3).toBe(false);
  });

  it('10일 고저폭 12%, 52주 고점 −20%까지', () => {
    expect(run({ f: { range10: 12 } }).groups.g3).toBe(true);
    expect(run({ f: { range10: 12.01 } }).groups.g3).toBe(false);
    expect(run({ f: { gap52h: -20.01 } }).groups.g3).toBe(false);
  });

  it('피봇 위치로 알림 여부가 갈린다', () => {
    const at = (close) => run({ f: { close } });
    expect(at(9200).status).toBe('setup'); // −8%
    expect(at(9199).status).toBe('far_below_pivot');
    expect(at(10000).status).toBe('setup'); // 피봇과 같음
    expect(at(10001).status).toBe('breaking_out');
    expect(at(10499).status).toBe('breaking_out');
    expect(at(10500).status).toBe('extended'); // +5%
    expect(at(10500).action).toBe('watch');
  });

  it('거래대금 10억 미만은 다른 조건과 상관없이 제외', () => {
    const got = run({ f: { tv20: 9.99 } });
    expect(got.action).toBe('exclude');
    expect(got.status).toBe('illiquid');
  });

  it('1그룹이면 2그룹과 겹쳐도 제외', () => {
    const got = run({ s: { rel: 1.5 }, f: { distMa50: 30 } });
    expect(got.groups.g1).toBe(true);
    expect(got.groups.g2).toBe(true);
    expect(got.action).toBe('exclude');
  });

  it('피봇이 없으면 3그룹이 아니고 주문도 없다', () => {
    const got = run({ pv: null });
    expect(got.groups.g3).toBe(false);
    expect(got.pivot).toBeNull();
    expect(got.orders).toBeNull();
  });

  it('2그룹만이면 점수에 따라 후보/대기', () => {
    expect(run({ pv: { contractions: 2 } }).status).toBe('g3_candidate');
    const low = run({ pv: { contractions: 2 }, f: { range10: 13, atr14p: 5, depth60: 31 } });
    expect(low.status).toBe('g2');
  });
});

describe('g2Score', () => {
  it('일곱 조건 중 통과한 수를 센다', () => {
    expect(g2Score(F, S).score).toBe(7);
    const got = g2Score({ ...F, range10: 13, from52l: 101 }, { ...S, ex21: 5.6 });
    expect(got.score).toBe(4);
    expect(got.candidate).toBe(false);
  });
});

describe('주문 가격과 호가 단위', () => {
  it('호가 단위 경계', () => {
    expect([1999, 2000, 4999, 5000, 19999, 20000].map(tickSize)).toEqual([1, 5, 5, 10, 10, 50]);
    expect([49999, 50000, 199999, 200000, 499999, 500000].map(tickSize)).toEqual([
      50, 100, 100, 500, 500, 1000,
    ]);
    expect(floorToTick(174309)).toBe(174300);
  });

  it('KT&G 피봇 179,700 기준', () => {
    expect(orders(179700)).toEqual({
      alert: 174300,
      buyStop: 179700,
      chaseLimit: 188600,
      stopLoss: 165300,
      takeProfit: 222500,
    });
  });
});
