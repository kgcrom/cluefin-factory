import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrations } from '../scripts/pit/db.mjs';
import { main } from '../scripts/pit.mjs';

describe('pit.mjs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('migrate·stats·rebuild가 빈 DB에서 돈다', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = join(mkdtempSync(join(tmpdir(), 'pit-cli-')), 'nested', 'pit.sqlite');
    expect(main(['migrate', '--db', db])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      schema_version: migrations().at(-1).version,
      rows: { raw: 0 },
    });
    expect(main(['rebuild', '--db', db])).toBe(0);
    expect(JSON.parse(log.mock.calls[1][0])).toEqual({ replayed: 0, skipped: 0 });
    expect(main(['stats', '--db', db])).toBe(0);
  });

  it('fill은 종목·기준일·벤치마크 형식이 틀리면 CLI를 부르지 않고 exit 2', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = vi.fn();
    const db = join(mkdtempSync(join(tmpdir(), 'pit-cli-')), 'pit.sqlite');
    const args = ['fill', '--symbol', '5930', '--as-of', '20240628', '--benchmark', '2001'];
    expect(main([...args, '--db', db], { fetcherOptions: { cli } })).toBe(2);
    expect(main(['fill', 'stray'])).toBe(2);
    expect(
      main([...args.slice(0, 2), '005930', ...args.slice(3), '--horizon', 'abc', '--db', db], {
        fetcherOptions: { cli },
      }),
    ).toBe(2);
    expect(cli).not.toHaveBeenCalled();
  });

  it('모르는 명령은 exit 2', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['fetch'])).toBe(2);
  });
});
