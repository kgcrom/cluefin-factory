import { describe, expect, it } from 'vitest';
import { findLeaks, maskText } from '../scripts/blind/mask.mjs';

describe('maskText', () => {
  it('회사명은 긴 이름부터 지운다', () => {
    expect(
      maskText('삼성전자우 배당 — 삼성전자 이사회', { names: ['삼성전자', '삼성전자우'] }),
    ).toBe('[회사] 배당 — [회사] 이사회');
  });

  it('정기보고서 제목의 연도·기수를 지우고 월은 남긴다', () => {
    expect(maskText('[기재정정]사업보고서 (2023.12) 제55기')).toBe(
      '[기재정정]사업보고서 ([연도].12) 제[N]기',
    );
  });

  it('종목코드와 8자리 날짜를 지운다', () => {
    expect(maskText('005930 기준일 20240628 공시')).toBe('[코드] 기준일 [날짜] 공시');
  });

  it('긴 숫자 안의 네 자리는 연도로 보지 않는다', () => {
    expect(maskText('발행주식 120150주, 1,2015원')).toBe('발행주식 [코드]주, 1,[연도]원');
    expect(maskText('금액 1234567890')).toBe('금액 1234567890');
  });
});

describe('findLeaks', () => {
  const guard = { symbol: '005930', names: ['삼성전자'] };

  it('깨끗한 케이스는 빈 배열이다', () => {
    expect(findLeaks({ prices: [{ d: 0, close: 100 }], title: '[회사] 주요사항' }, guard)).toEqual(
      [],
    );
  });

  it('이름·코드·연도·날짜 모양 숫자를 경로와 함께 잡는다', () => {
    const leaks = findLeaks(
      {
        disclosures: [{ title: '삼성전자 분기보고서 (2024.03)' }],
        note: '005930',
        stamp: 20240628,
      },
      guard,
    );
    expect(leaks.map((leak) => leak.path)).toEqual([
      '$.disclosures[0].title',
      '$.disclosures[0].title',
      '$.note',
      '$.note',
      '$.stamp',
    ]);
  });

  it('객체 키도 검사한다', () => {
    expect(findLeaks({ 2024: 1 }, guard)).toHaveLength(1);
  });
});
