/**
 * Text from the latest periodic report itself (cluefin `dart document-section` and
 * `dart financial-notes`): the business overview, sales and orders, and the notes on
 * borrowings, related parties, contingencies and lawsuits. The DART JSON APIs carry
 * none of this — segment revenue, order backlog and debt maturities live only in the
 * filed document.
 *
 * Which parts are read, and how much of each, is fixed here so every run hands the
 * analysts the same excerpt. Anything else in the filing stays one CLI call away
 * (`dart document-outline` → `document-section --index`).
 */

/** Note titles worth reading for every company: debt structure, related parties, contingent risk. */
export const NOTE_TERMS = ['차입금', '사채', '특수관계자', '우발', '소송'];
/** Title of the 사업의 내용 subsection with segment revenue and order backlog (title, not code: codes moved between years). */
export const SALES_TITLE = '매출 및 수주상황';
/** Characters of text per part. A large cap's whole business section is ~40k, its notes ~130k. */
// Notes are cut in document order, so a long related-party note (11k on 192820 2Q26) used to
// crowd the contingency note after it out at 12000.
export const LIMITS = { overview: 6000, sales: 8000, notes: 20000 };
const NOTE_BASIS = { CFS: 'consolidated', OFS: 'separate' };

/** CLI block → compact form: text as a string, a table as unit + rows, a subsection marker as `{ section }`. */
export function compactBlock(block) {
  if (block.type === 'table') {
    return {
      unit: block.unit ?? null,
      ...(block.caption ? { caption: block.caption } : {}),
      rows: block.rows,
    };
  }
  if (block.type === 'section') return { section: block.title };
  return block.text;
}

function section(cli, base, selector, maxChars) {
  const payload = cli([
    'dart',
    'document-section',
    ...base,
    ...selector,
    '--max-chars',
    String(maxChars),
  ]);
  if (payload.sections.length === 0) return null;
  return {
    sections: payload.sections.map((s) => ({ title: s.title, blocks: s.blocks.map(compactBlock) })),
    chars: payload.total_chars,
    truncated: payload.truncated,
  };
}

function notes(cli, base, basis) {
  const notesArgs = ['dart', 'financial-notes', ...base, '--basis', basis];
  const [toc] = cli(notesArgs).sources;
  if (!toc) return null;
  const picked = cli([
    ...notesArgs,
    '--title-contains',
    NOTE_TERMS.join(','),
    '--max-chars',
    String(LIMITS.notes),
  ]);
  return {
    basis,
    sectionTitle: toc.section_title,
    splitMethod: toc.split_method,
    // The splitter's own doubts (a skipped number, a note it may have missed). Never dropped.
    warnings: toc.warnings,
    toc: toc.notes.map((n) => ({ number: n.number, title: n.title, chars: n.chars })),
    selected: (picked.sources[0]?.notes ?? []).map((n) => ({
      number: n.number,
      title: n.title,
      chars: n.chars,
      blocks: n.blocks.map(compactBlock),
    })),
    truncated: picked.truncated,
  };
}

/**
 * Excerpts of the report `rceptNo`. `statementBasis` is collect's CFS/OFS choice, so the
 * notes match the statements the report already shows.
 */
export function filingText(cli, { corpCode, rceptNo, statementBasis }) {
  const base = ['--rcept-no', rceptNo, '--corp-code', corpCode];
  return {
    rceptNo,
    businessOverview: section(cli, base, ['--section', 'business-overview'], LIMITS.overview),
    salesAndOrders: section(cli, base, ['--title', SALES_TITLE], LIMITS.sales),
    notes: notes(cli, base, NOTE_BASIS[statementBasis] ?? 'consolidated'),
  };
}
