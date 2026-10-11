import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { indexFor, strength } from '../scripts/watchlist/strength.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const load = (name) =>
  JSON.parse(readFileSync(join(ROOT, `tests/fixtures/${name}-20261006.json`), 'utf8'));
const INDEX = { KOSPI: load('watchlist-index-0001'), KOSDAQ: load('watchlist-index-1001') };

describe('strength — 백테스트와 같은 값', () => {
  it.each(['033780', '068790', '028670', '092870'])('%s', (symbol) => {
    const { candles, market, expected } = load(`watchlist-${symbol}`);
    const got = strength(candles, INDEX[market].closes);
    expect(got.rel).toBeCloseTo(expected.rel, 6);
    expect(got.ex21).toBeCloseTo(expected.ex21, 6);
  });

  it('지수보다 약하면 1 미만, 강하면 1 초과 (KT&G 0.81, 엑시콘 2.95)', () => {
    const ktng = load('watchlist-033780');
    const exicon = load('watchlist-092870');
    expect(strength(ktng.candles, INDEX.KOSPI.closes).rel.toFixed(2)).toBe('0.81');
    expect(strength(exicon.candles, INDEX.KOSDAQ.closes).rel.toFixed(2)).toBe('2.95');
  });
});

describe('strength — 날짜와 길이', () => {
  const { candles } = load('watchlist-033780');
  const closes = INDEX.KOSPI.closes;

  it('지수는 종목의 마지막 날짜에서 읽고, 그 뒤 날짜는 쓰지 않는다', () => {
    const later = [...closes, { date: '20261007', close: 1 }];
    expect(strength(candles, later)).toEqual(strength(candles, closes));
  });

  it('지수에 그날 종가가 없으면 가까운 날로 넘기지 않고 오류', () => {
    expect(() => strength(candles, closes.slice(0, -1))).toThrow('20261006');
  });

  it('어느 한쪽이라도 251개보다 짧으면 null', () => {
    expect(strength(candles.slice(-250), closes)).toBeNull();
    expect(strength(candles, closes.slice(-250))).toBeNull();
  });
});

describe('indexFor', () => {
  it('코스피는 0001, 코스닥은 1001 — 코스피200이 아니다', () => {
    expect(indexFor('KOSPI')).toBe('0001');
    expect(indexFor('KOSDAQ')).toBe('1001');
    expect(() => indexFor('KONEX')).toThrow();
  });
});
