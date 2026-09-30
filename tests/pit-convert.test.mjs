import { describe, expect, it } from 'vitest';
import { nextTradingDay } from '../scripts/pit/calendar.mjs';
import {
  ConvertError,
  compactDate,
  toInt,
  toReal,
  unsignedPrice,
} from '../scripts/pit/convert.mjs';

describe('toInt', () => {
  it('쉼표를 지운다', () => {
    expect(toInt('5,969,782,550')).toBe(5969782550);
  });
  it('값 없음은 0이 아니라 null이다', () => {
    for (const missing of ['-', '', '  ', '#########', null, undefined]) {
      expect(toInt(missing)).toBeNull();
    }
  });
  it('"81500.0"은 정수로 받고 소수부가 있으면 거부한다', () => {
    expect(toInt('81500.0')).toBe(81500);
    expect(() => toInt('81500.5')).toThrow(ConvertError);
  });
  it('음수와 부호', () => {
    expect(toInt('-190,143,795')).toBe(-190143795);
    expect(toInt('+28915427')).toBe(28915427);
  });
  it('안전 정수를 넘으면 조용히 반올림하지 않고 거부한다', () => {
    expect(toInt('514,000,000,000,000')).toBe(514e12);
    expect(() => toInt('9007199254740993')).toThrow(/안전 정수/);
  });
  it('숫자가 아닌 문자열은 거부한다', () => {
    expect(() => toInt('N/A')).toThrow(ConvertError);
  });
});

describe('toReal', () => {
  it('소수·음수·값 없음', () => {
    expect(toReal('2797.82')).toBe(2797.82);
    expect(toReal('-0.12')).toBe(-0.12);
    expect(toReal('1,234.5')).toBe(1234.5);
    expect(toReal('-')).toBeNull();
    expect(() => toReal('1.2.3')).toThrow(ConvertError);
  });
});

describe('unsignedPrice', () => {
  it('키움의 등락 부호를 떼어낸다', () => {
    expect(unsignedPrice('-81500')).toBe(81500);
    expect(unsignedPrice('+81500')).toBe(81500);
    expect(unsignedPrice('')).toBeNull();
  });
});

describe('compactDate', () => {
  it('YYYYMMDD만 받는다', () => {
    expect(compactDate('20240628')).toBe('20240628');
    for (const bad of ['2024-06-28', '20241328', '240628', '0020240628']) {
      expect(() => compactDate(bad)).toThrow(ConvertError);
    }
  });
});

describe('nextTradingDay', () => {
  // 2024-06-06 현충일 휴장
  const calendar = ['20240603', '20240604', '20240605', '20240607', '20240610'];
  it('다음 거래일 — 휴장일과 주말을 건너뛴다', () => {
    expect(nextTradingDay(calendar, '20240604')).toBe('20240605');
    expect(nextTradingDay(calendar, '20240605')).toBe('20240607');
    expect(nextTradingDay(calendar, '20240606')).toBe('20240607');
    expect(nextTradingDay(calendar, '20240608')).toBe('20240610');
  });
  it('달력이 답할 수 없으면 추측하지 않고 null', () => {
    expect(nextTradingDay(calendar, '20240610')).toBeNull();
    expect(nextTradingDay(calendar, '20240601')).toBeNull();
    expect(nextTradingDay([], '20240601')).toBeNull();
  });
});
