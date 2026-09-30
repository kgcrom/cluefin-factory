import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide } from '../scripts/blind/guard-read.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = join(mkdtempSync(join(tmpdir(), 'guard-')), '.claude/investments/blind/pilot');
mkdirSync(join(base, 'cases'), { recursive: true });
mkdirSync(join(base, 'seals'), { recursive: true });
const casePath = join(base, 'cases/abcdefghijkl.json');
const sealPath = join(base, 'seals/abcdefghijkl.json');
writeFileSync(casePath, '{}');
writeFileSync(sealPath, '{}');
symlinkSync(sealPath, join(base, 'cases/zzzzzzzzzzzz.json'));

const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });

describe('guard-read', () => {
  it('케이스 파일과 판단 스키마만 허용한다', () => {
    expect(decide(read(casePath))).toEqual({ allowed: true });
    expect(decide(read(join(ROOT, 'schemas/final-decision.schema.json')))).toEqual({
      allowed: true,
    });
    expect(decide(read(join(ROOT, 'schemas/blind-case.schema.json'))).allowed).toBe(false);
  });

  it('봉인·등록부·저장소 파일은 막는다', () => {
    expect(decide(read(sealPath)).allowed).toBe(false);
    expect(decide(read(join(base, 'registry.json'))).allowed).toBe(false);
    expect(decide(read(join(ROOT, 'AGENTS.md'))).allowed).toBe(false);
  });

  it('cases/ 안의 심볼릭 링크로 봉인을 읽지 못한다', () => {
    expect(decide(read(join(base, 'cases/zzzzzzzzzzzz.json'))).allowed).toBe(false);
  });

  it('경로 조작(..)을 막는다', () => {
    expect(decide(read(join(base, 'cases/../seals/abcdefghijkl.json'))).allowed).toBe(false);
  });

  it('Read 외 도구는 전부 막는다', () => {
    expect(decide({ tool_name: 'Bash', tool_input: { command: 'cat x' } }).allowed).toBe(false);
    expect(decide(null).allowed).toBe(false);
  });

  it('훅으로 실행하면 막을 때 exit 2와 사유를 낸다', () => {
    const run = (payload) =>
      spawnSync('node', [join(ROOT, 'scripts/blind/guard-read.mjs')], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
      });
    expect(run(read(casePath)).status).toBe(0);
    const blocked = run(read(sealPath));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/케이스 파일/);
  });
});
