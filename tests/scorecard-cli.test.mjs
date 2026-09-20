/** CLI 진입점 계약: 인자 해석과 score()의 조회·쓰기 경로. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CUTOFF } from '../scripts/lib/rules.mjs';
import { parseArgs, score, selectPending } from '../scripts/scorecard.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DECISIONS = join(ROOT, 'tests/fixtures/decisions');
const series = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/series-383220.json'), 'utf8'));
const TODAY = '20260919';

/**
 * 픽스처를 임시 디렉터리로 옮기면서 `scoring`을 pending으로 되돌린다. 픽스처는 이미
 * 채점된 상태라 그대로는 selectPending이 걸러내고, --write는 원본을 건드리면 안 된다.
 */
function scratch(...files) {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
  for (const file of files) {
    const text = readFileSync(join(DECISIONS, file), 'utf8');
    writeFileSync(
      join(dir, file),
      text.replace(/^scoring:\n(?:[ \t]+.*\n)*/m, 'scoring:\n  status: pending\n'),
    );
  }
  return dir;
}

const feed = () => ({
  fetchPrices: vi.fn(() => series.prices),
  fetchIndex: vi.fn(() => series.index),
});

describe('parseArgs', () => {
  it('플래그가 없으면 기본값은 오프라인·쓰기 없음이다', () => {
    const { paths, options } = parseArgs([]);

    expect(paths).toEqual([]);
    expect(options).toEqual({ cutoff: DEFAULT_CUTOFF, json: false });
    // 없는 것이 기본값이라는 사실 자체가 계약이다 — 조용히 켜지면 안 된다.
    expect(options.write).toBeUndefined();
    expect(options.withAtr).toBeUndefined();
  });

  it('값을 받는 옵션과 받지 않는 옵션을 구분한다', () => {
    const { paths, options } = parseArgs([
      'a.md',
      '--today',
      '20260101',
      '--atr',
      '--write',
      '--cutoff',
      '2026-03',
      'b.md',
      '--json',
    ]);

    expect(paths).toEqual(['a.md', 'b.md']);
    expect(options).toMatchObject({
      today: '20260101',
      withAtr: true,
      write: true,
      cutoff: '2026-03',
      json: true,
    });
  });

  it('모르는 옵션은 조용히 무시하지 않고 던진다', () => {
    // 오타가 무시되면 --wirte 하나로 쓰기가 사라진 것을 아무도 모른다.
    expect(() => parseArgs(['--wirte'])).toThrow('--wirte');
  });
});

describe('selectPending', () => {
  it('supersedes 체인의 옛 판단을 표시한다', () => {
    const entries = [
      { data: { decision_id: 'a', scoring: { status: 'pending' } } },
      { data: { decision_id: 'b', supersedes: 'a', scoring: { status: 'pending' } } },
      { data: { decision_id: 'c', scoring: { status: 'scored' } } },
    ];

    expect(
      selectPending(entries).map((row) => [row.entry.data.decision_id, row.superseded]),
    ).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});

describe('score', () => {
  it('조회 구간은 판단의 기준일에서 시작해 오늘과 review_due 중 이른 쪽에서 끝난다', () => {
    const { fetchPrices, fetchIndex } = feed();

    const results = score([scratch('2026-06-19-383220-02.md')], {
      today: TODAY,
      fetchPrices,
      fetchIndex,
    });

    // review_due(2026-09-17)가 오늘(09-19)보다 이르므로 그날로 끊는다.
    expect(fetchPrices).toHaveBeenCalledWith('383220', '20260619', '20260917');
    // KOSPI 판단이므로 벤치마크는 KOSPI200(2001)이다.
    expect(fetchIndex).toHaveBeenCalledWith('2001', '20260619', '20260917');
    expect(results[0].result).toMatchObject({ status: 'invalidated', outcome: 'incorrect' });
    expect(results[0].written).toBe(false);
  });

  it('--write 없이는 파일을 건드리지 않는다', () => {
    const dir = scratch('2026-06-19-383220-02.md');
    const path = join(dir, '2026-06-19-383220-02.md');
    const before = readFileSync(path, 'utf8');

    score([dir], { today: TODAY, ...feed() });

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('--write는 scoring 블록만 갈아끼운다', () => {
    const dir = scratch('2026-06-19-383220-02.md');
    const path = join(dir, '2026-06-19-383220-02.md');
    const before = readFileSync(path, 'utf8');

    const results = score([dir], { today: TODAY, write: true, scoredAt: '2026-09-19', ...feed() });

    const after = readFileSync(path, 'utf8');
    expect(results[0].written).toBe(true);
    expect(after).toContain('status: invalidated');
    expect(after).not.toContain('status: pending');
    // 본문은 그대로다 — 채점이 판단을 고쳐 쓰면 안 된다.
    expect(after.slice(after.indexOf('---', 3))).toBe(before.slice(before.indexOf('---', 3)));
  });
});
