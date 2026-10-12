import { describe, expect, it } from 'vitest';
import { kstClock, lookbackStart } from '../scripts/lib/kst.mjs';

describe('lookbackStart', () => {
  it('달력일로 거슬러 올라가며 달과 해를 넘는다', () => {
    expect(lookbackStart('20261012', 365)).toBe('20251012');
    expect(lookbackStart('20260301', 1)).toBe('20260228');
    expect(lookbackStart('20260105', 10)).toBe('20251226');
  });
});

describe('kstClock', () => {
  it('UTC를 KST 날짜·분으로 바꾼다', () => {
    expect(kstClock(new Date('2026-10-11T23:30:00Z'))).toEqual({ date: '20261012', minutes: 510 });
  });
});
