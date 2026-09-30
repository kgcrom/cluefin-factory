import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../scripts/blind.mjs';

describe('blind.mjs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('모르는 명령·필수 인자 누락은 CLI·판단기를 부르지 않고 exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = vi.fn();
    const invoke = vi.fn();
    const deps = { cli, invoke };
    expect(await main(['score'], deps)).toBe(2);
    expect(await main(['register', '--run', 'x', '--seed', 'abc', '--count', '30'], deps)).toBe(2);
    expect(await main(['build'], deps)).toBe(2);
    expect(await main(['judge'], deps)).toBe(2);
    expect(await main(['restore'], deps)).toBe(2);
    expect(await main(['status', 'stray'], deps)).toBe(2);
    expect(cli).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
