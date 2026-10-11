import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  features,
  MIN_CANDLES,
  returnPct,
  trueRange,
  weightedReturn,
} from '../scripts/watchlist/features.mjs';
import { fractalHighs, pivot } from '../scripts/watchlist/pivot.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = (symbol) =>
  JSON.parse(readFileSync(join(ROOT, `tests/fixtures/watchlist-${symbol}-20261006.json`), 'utf8'));

// 10-06 종가 기준 실제 일봉 300개와, 백테스트 파이썬 코드가 같은 일봉으로 낸 값.
const SYMBOLS = ['033780', '068790', '028670', '092870'];

// JS 이름 → 백테스트(파이썬) 이름
const NAMES = {
  close: 'close',
  ma50: 'ma50',
  ma150: 'ma150',
  ma200: 'ma200',
  hi52: 'hi52',
  lo52: 'lo52',
  gap52h: 'gap52h',
  from52l: 'from52l',
  r21: 'r21',
  rsRaw: 'rs_raw',
  range10: 'range10',
  atr14p: 'atr14p',
  v20to50: 'v20_50',
  tv20: 'tv20',
  distMa50: 'dist_ma50',
  depth60: 'depth60',
};

/** n candles with the given highs; lows sit 10 below, closes 5 below. */
const candlesFromHighs = (highs) =>
  highs.map((high, i) => ({
    date: String(20260101 + i),
    open: high - 5,
    high,
    low: high - 10,
    close: high - 5,
    volume: 1000,
    value: 1e9,
  }));

describe('features — 백테스트와 같은 값', () => {
  it.each(SYMBOLS)('%s', (symbol) => {
    const { candles, expected } = fixture(symbol);
    const got = features(candles);
    for (const [js, py] of Object.entries(NAMES)) {
      expect(got[js], js).toBeCloseTo(expected[py], 6);
    }
    expect(got.tt).toBe(expected.tt);
    expect(got.date).toBe('20261006');
  });

  it('52주 고점은 당일을 빼고 장중 고가로 잡는다', () => {
    const { candles } = fixture('092870');
    const got = features(candles);
    const prior = candles.slice(-251, -1).map((c) => c.high);
    expect(got.hi52).toBe(Math.max(...prior));
    // 당일 고가가 더 높아도 갭은 직전 고점 기준이라 플러스가 될 수 있다.
    const lifted = candles.map((c, i) =>
      i === candles.length - 1 ? { ...c, high: 1e9, close: got.hi52 * 1.05 } : c,
    );
    expect(features(lifted).gap52h).toBeCloseTo(5, 6);
  });
});

describe('features — 길이와 보조 함수', () => {
  it(`일봉이 ${MIN_CANDLES}개보다 적으면 null`, () => {
    const { candles } = fixture('033780');
    expect(features(candles.slice(-(MIN_CANDLES - 1)))).toBeNull();
    expect(features(candles.slice(-MIN_CANDLES))).not.toBeNull();
    expect(features(undefined)).toBeNull();
  });

  it('weightedReturn은 최근 분기를 두 번 센다', () => {
    const closes = Array.from({ length: 251 }, () => 100);
    expect(weightedReturn(closes)).toBe(5);
    closes[250] = 200; // 모든 기간 수익이 2배
    expect(weightedReturn(closes)).toBe(10);
    expect(weightedReturn(closes.slice(1))).toBeNull();
  });

  it('returnPct는 길이가 모자라면 null', () => {
    expect(returnPct([100, 110], 1)).toBeCloseTo(10, 9);
    expect(returnPct([100, 110], 2)).toBeNull();
  });

  it('trueRange는 전일 종가와의 갭까지 잡는다', () => {
    const candles = [
      { high: 100, low: 90, close: 95 },
      { high: 120, low: 110, close: 115 },
    ];
    expect(trueRange(candles, 0)).toBe(10);
    expect(trueRange(candles, 1)).toBe(25);
  });
});

describe('pivot — 픽스처 기댓값과 같다', () => {
  it.each(SYMBOLS)('%s', (symbol) => {
    const { candles, expected } = fixture(symbol);
    const got = pivot(candles);
    expect(got.price).toBe(expected.pivot);
    expect(got.lastContraction).toBeCloseTo(expected.last_contr, 6);
    expect(got.contractions).toBe(expected.n_legs);
  });

  it('KT&G 179,700 / 3.2%, DMS 8,160 / 9.9%, 팬오션 6,040 / 8.0%', () => {
    expect(pivot(fixture('033780').candles).price).toBe(179700);
    expect(pivot(fixture('068790').candles).lastContraction.toFixed(1)).toBe('9.9');
    expect(pivot(fixture('028670').candles).price).toBe(6040);
  });
});

describe('fractalHighs', () => {
  it('왼쪽 3봉보다 높고 오른쪽 3봉보다 낮지 않아야 한다', () => {
    //               0   1   2   3   4   5   6
    const highs = [10, 11, 12, 20, 19, 18, 17];
    expect(fractalHighs(highs)).toEqual([3]);
  });

  it('왼쪽에 같은 고가가 있으면 고점이 아니고, 오른쪽에 같은 고가는 허용한다', () => {
    expect(fractalHighs([20, 11, 12, 20, 19, 18, 17])).toEqual([]);
    expect(fractalHighs([10, 11, 12, 20, 20, 18, 17, 16])).toEqual([3]);
  });

  it('마지막 3봉 안의 고점은 아직 확정되지 않았다', () => {
    expect(fractalHighs([10, 11, 12, 13, 14, 30, 20, 19])).toEqual([]);
  });
});

describe('pivot — 수축 다리', () => {
  it('60일 최고가부터 스윙 고점마다 한 다리씩 세고, 피봇 봉 자신의 저가는 빼고 잰다', () => {
    const highs = [
      ...Array(10).fill(50),
      100,
      90,
      80,
      70,
      80, // 최고가 100 → 저가 60 (40%)
      95,
      85,
      80,
      82,
      84, // 스윙 고점 95 → 저가 70 (26.3%)
      90,
      86,
      84,
      85,
      87,
      88, // 스윙 고점 90 → 저가 74
    ];
    const got = pivot(candlesFromHighs(highs));
    expect(got.price).toBe(90);
    expect(got.contractions).toBe(3);
    expect(got.legs[0]).toBeCloseTo(40, 9);
    expect(got.legs[1]).toBeCloseTo((1 - 70 / 95) * 100, 9);
    expect(got.lastContraction).toBeCloseTo((1 - 74 / 90) * 100, 9);
    expect(got.age).toBe(5);
  });

  it('확정된 고점이 없으면 null', () => {
    expect(pivot(candlesFromHighs([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});
