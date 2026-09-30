import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../scripts/blind.mjs';

describe('blind.mjs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('모르는 명령·필수 인자 누락은 CLI를 부르지 않고 exit 2', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = vi.fn();
    expect(main(['judge'], { cli })).toBe(2);
    expect(main(['register', '--run', 'x', '--seed', 'abc', '--count', '30'], { cli })).toBe(2);
    expect(main(['build'], { cli })).toBe(2);
    expect(main(['restore'], { cli })).toBe(2);
    expect(main(['status', 'stray'], { cli })).toBe(2);
    expect(cli).not.toHaveBeenCalled();
  });
});
