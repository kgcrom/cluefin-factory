import { describe, expect, it, vi } from 'vitest';
import { dailyCandles, previousDay, sectorDailyRange } from '../scripts/lib/cluefin.mjs';

/** A fake index that returns at most 100 trading days ending on the given date. */
function fakeIndex(fromDate, count) {
  const rows = [];
  const iso = `${fromDate.slice(0, 4)}-${fromDate.slice(4, 6)}-${fromDate.slice(6, 8)}`;
  let at = Date.parse(`${iso}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    const day = new Date(at);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      rows.push({ date: day.toISOString().slice(0, 10).replaceAll('-', ''), close: 1000 + i });
    }
    at += 86_400_000;
  }
  return (endingOn) => rows.filter((row) => row.date <= endingOn).slice(-100);
}

describe('previousDay', () => {
  it('달과 해를 넘어간다', () => {
    expect(previousDay('20260301')).toBe('20260228');
    expect(previousDay('20260101')).toBe('20251231');
  });
});

describe('dailyCandles', () => {
  it('가격 시계열도 같은 100행 상한에 걸리므로 똑같이 나눠 부른다', () => {
    const fetchPage = vi.fn(fakeIndex('20250101', 700));
    const rows = dailyCandles('383220', '20250201', '20260901', { fetchPage });
    expect(fetchPage.mock.calls.length).toBeGreaterThan(1);
    expect(rows[0].date).toBe('20250203');
    expect(rows.at(-1).date).toBe('20260901');
  });
});

describe('sectorDailyRange', () => {
  it('100행 안에 들어오면 한 번만 부른다', () => {
    const fetchPage = vi.fn(fakeIndex('20260101', 120));
    const rows = sectorDailyRange('2001', '20260201', '20260301', { fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(rows[0].date >= '20260201').toBe(true);
  });

  it('100행을 넘는 구간은 나눠 부르고 병합한다', () => {
    const fetchPage = vi.fn(fakeIndex('20250101', 700));
    const rows = sectorDailyRange('2001', '20250201', '20260901', { fetchPage });
    expect(fetchPage.mock.calls.length).toBeGreaterThan(1);
    // 병합 결과는 요청 구간을 실제로 덮고, 중복도 역순도 없다
    expect(rows[0].date).toBe('20250203');
    expect(rows.at(-1).date).toBe('20260901');
    expect(new Set(rows.map((r) => r.date)).size).toBe(rows.length);
    expect([...rows].sort((a, b) => a.date.localeCompare(b.date))).toEqual(rows);
  });

  it('시작일이 데이터보다 앞서도 무한 루프에 빠지지 않는다', () => {
    const fetchPage = vi.fn(fakeIndex('20260101', 120));
    const rows = sectorDailyRange('2001', '20200101', '20260301', { fetchPage });
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(24);
    expect(rows[0].date).toBe('20260101');
  });

  it('빈 응답이면 즉시 멈춘다', () => {
    const fetchPage = vi.fn(() => []);
    expect(sectorDailyRange('2001', '20250101', '20260301', { fetchPage })).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
