import { SALES_TITLE } from '../../scripts/company/filing.mjs';

const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
export const TABLE = {
  type: 'table',
  caption: null,
  unit: '억원',
  rows: [
    ['부문', '매출'],
    ['A', '1,234'],
  ],
};

/** `dart document-section` / `dart financial-notes` answers shaped like cluefin's (synthetic text). */
export function fakeFilingCli(args) {
  if (args[1] === 'document-section') {
    if (flag(args, '--section') === 'business-overview') {
      return {
        sections: [{ title: '1. 사업의 개요', blocks: [{ type: 'paragraph', text: '부품 사업' }] }],
        total_chars: 5,
        truncated: false,
      };
    }
    if (flag(args, '--title') === SALES_TITLE) {
      return {
        sections: [
          {
            title: '4. 매출 및 수주상황',
            blocks: [{ type: 'section', level: 3, title: '가. 매출실적', assoc_code: null }, TABLE],
          },
        ],
        total_chars: 9000,
        truncated: true,
      };
    }
  }
  if (args[1] === 'financial-notes') {
    const toc = {
      section_title: '3. 연결재무제표 주석',
      split_method: 'heading',
      warnings: ['3번 노트가 없습니다(4번으로 건너뜀).'],
      notes: [
        { number: '1', title: '일반사항', chars: 300, tables: 0 },
        { number: '9', title: '차입금', chars: 1600, tables: 2 },
      ],
    };
    if (!flag(args, '--title-contains')) return { mode: 'toc', sources: [toc] };
    return {
      mode: 'notes',
      sources: [{ ...toc, notes: [{ ...toc.notes[1], heading: '9. 차입금', blocks: [TABLE] }] }],
      truncated: false,
    };
  }
  throw new Error(`fake CLI: ${args.join(' ')}`);
}
