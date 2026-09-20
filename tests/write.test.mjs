import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter, splitEntry } from '../scripts/lib/journal.mjs';
import { applyScoring, renderScoring, scoringNotes } from '../scripts/lib/write.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const original = readFileSync(join(ROOT, 'tests/fixtures/valid-retro-seed.md'), 'utf8');

const result = {
  status: 'invalidated',
  endDate: '20260623',
  price_at_review: 73200,
  return_pct: -9.96,
  benchmark_return_pct: -9.44,
  excess_long: -0.52,
  max_drawdown_pct: -12.05,
  stop_hit: true,
  target_hit: false,
  invalidated_by: ['inv-2'],
  outcome: 'incorrect',
  elapsed_days: 4,
  elapsed_ratio: 4.44,
  early_exit: true,
  index_volatility_pct: 5.87,
  within_noise: true,
  manual_conditions: [],
};

const rendered = renderScoring(result, {
  scoredAt: '2026-09-19T12:05:00+09:00',
  referenceDate: '20260619',
});

describe('scoring 블록 쓰기', () => {
  it('scoring 블록만 갈아끼우고 나머지는 한 글자도 건드리지 않는다', () => {
    const updated = applyScoring(original, rendered);
    const before = splitEntry(original).frontmatter.split('\nscoring:')[0];
    const after = splitEntry(updated).frontmatter.split('\nscoring:')[0];
    expect(after).toBe(before);
    expect(splitEntry(updated).body).toBe(splitEntry(original).body);
  });

  it('다시 읽으면 계산값이 그대로 나온다', () => {
    const data = parseFrontmatter(splitEntry(applyScoring(original, rendered)).frontmatter);
    expect(data.scoring).toMatchObject({
      status: 'invalidated',
      price_at_review: 73200,
      return_pct: -9.96,
      // 산문이 아니라 필드로 남아야 집계가 다시 읽을 수 있다
      excess_long: -0.52,
      early_exit: true,
      within_noise: true,
      invalidated_by: ['inv-2'],
      outcome: 'incorrect',
    });
    expect(data.decision_id).toBe('2026-07-24-000000-01');
  });

  it('기한 미도래 판단은 pending 그대로 남긴다', () => {
    expect(renderScoring({ status: 'pending' }, {})).toBe('scoring:\n  status: pending\n');
  });

  it('scoring 블록이 없으면 조용히 넘어가지 않고 실패한다', () => {
    expect(() => applyScoring('---\nverdict: buy\n---\n본문\n', rendered)).toThrow(
      'scoring 블록을 찾지 못했다',
    );
  });
});

describe('notes는 사실만 적는다', () => {
  it('발동 조건·경과율·초과수익·조회 구간을 담는다', () => {
    const notes = scoringNotes(result, { referenceDate: '20260619' });
    expect(notes).toContain('inv-2');
    expect(notes).toContain('4.44%');
    expect(notes).toContain('excess_long -0.52%p');
    expect(notes).toContain('20260619~20260623');
    expect(notes).toContain('노이즈 범위');
  });

  it('기한 도래 건은 조기 종료 문구를 붙이지 않는다', () => {
    const notes = scoringNotes(
      { ...result, invalidated_by: [], early_exit: false, within_noise: false },
      { referenceDate: '20260818' },
    );
    expect(notes).toContain('기한 도래 정상 채점');
    expect(notes).not.toContain('조기 종료');
  });
});
