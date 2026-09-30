import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../scripts/pit.mjs';

describe('pit.mjs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('migrate·stats·rebuild가 빈 DB에서 돈다', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = join(mkdtempSync(join(tmpdir(), 'pit-cli-')), 'nested', 'pit.sqlite');
    expect(main(['migrate', '--db', db])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ schema_version: 1, rows: { raw: 0 } });
    expect(main(['rebuild', '--db', db])).toBe(0);
    expect(JSON.parse(log.mock.calls[1][0])).toEqual({ replayed: 0, skipped: 0 });
    expect(main(['stats', '--db', db])).toBe(0);
  });

  it('모르는 명령은 exit 2', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['fetch'])).toBe(2);
  });
});
