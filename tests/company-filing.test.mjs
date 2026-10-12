import { describe, expect, it, vi } from 'vitest';
import { compactBlock, filingText, LIMITS, NOTE_TERMS } from '../scripts/company/filing.mjs';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { fakeFilingCli, TABLE } from './fixtures/filing-cli.mjs';

const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const BASE = { corpCode: '00000001', rceptNo: '20260814000001', statementBasis: 'CFS' };

describe('company filing text', () => {
  it('사업의 개요·매출 및 수주상황·주석 발췌를 고정된 인자로 읽는다', () => {
    const cli = vi.fn(fakeFilingCli);
    const out = filingText(cli, BASE);

    expect(out.businessOverview).toEqual({
      sections: [{ title: '1. 사업의 개요', blocks: ['부품 사업'] }],
      chars: 5,
      truncated: false,
    });
    expect(out.salesAndOrders.truncated).toBe(true);
    expect(out.salesAndOrders.sections[0].blocks).toEqual([
      { section: '가. 매출실적' },
      { unit: '억원', rows: TABLE.rows },
    ]);
    expect(out.notes).toMatchObject({
      basis: 'consolidated',
      splitMethod: 'heading',
      warnings: ['3번 노트가 없습니다(4번으로 건너뜀).'],
      toc: [
        { number: '1', title: '일반사항', chars: 300 },
        { number: '9', title: '차입금', chars: 1600 },
      ],
      selected: [{ number: '9', title: '차입금', blocks: [{ unit: '억원', rows: TABLE.rows }] }],
      truncated: false,
    });

    const calls = cli.mock.calls.map(([args]) => args);
    for (const args of calls) {
      expect(flag(args, '--rcept-no')).toBe(BASE.rceptNo);
      expect(flag(args, '--corp-code')).toBe(BASE.corpCode);
    }
    expect(flag(calls[0], '--max-chars')).toBe(String(LIMITS.overview));
    expect(flag(calls[1], '--max-chars')).toBe(String(LIMITS.sales));
    expect(flag(calls.at(-1), '--title-contains')).toBe(NOTE_TERMS.join(','));
    expect(flag(calls.at(-1), '--max-chars')).toBe(String(LIMITS.notes));
  });

  it('별도 기준 재무제표면 별도 주석을 읽는다', () => {
    const cli = vi.fn(fakeFilingCli);
    filingText(cli, { ...BASE, statementBasis: 'OFS' });
    const notesCalls = cli.mock.calls.filter(([args]) => args[1] === 'financial-notes');
    expect(notesCalls.map(([args]) => flag(args, '--basis'))).toEqual(['separate', 'separate']);
  });

  it('없는 섹션·주석은 null', () => {
    const cli = (args) =>
      args[1] === 'document-section'
        ? { sections: [], total_chars: 0, truncated: false, hint: 'No section matched.' }
        : { mode: 'toc', sources: [] };
    expect(filingText(cli, BASE)).toEqual({
      rceptNo: BASE.rceptNo,
      businessOverview: null,
      salesAndOrders: null,
      notes: null,
    });
  });

  it('CLI 오류는 그대로 올린다(collect가 받아 적는다)', () => {
    const cli = () => {
      throw new CluefinError(2, 'unknown command');
    };
    expect(() => filingText(cli, BASE)).toThrow(CluefinError);
  });

  it('블록 축약: 문단은 문자열, 캡션 있는 표만 caption', () => {
    expect(compactBlock({ type: 'heading', text: '가. 개요' })).toBe('가. 개요');
    expect(compactBlock({ ...TABLE, caption: '(단위: 억원)' })).toEqual({
      unit: '억원',
      caption: '(단위: 억원)',
      rows: TABLE.rows,
    });
  });
});
