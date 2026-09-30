#!/usr/bin/env node
/**
 * PreToolUse hook for the `blind-judge` subagent: its only tool is Read, and
 * this lets Read open a blind case file and the decision schema, nothing else. Seals, the registry,
 * the PIT store and the rest of the repo stay out of reach — a judge that could
 * read a seal would be scoring its own answer key.
 *
 * Exit 0 allows the call; exit 2 blocks it and the stderr text goes back to the
 * model as the reason.
 */
import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Relative to the repository root — a matching path anywhere else is not a case. */
const CASE_FILE = /^\.claude\/investments\/blind\/[a-z0-9_-]+\/cases\/[a-z]{12}\.json$/;
/** The decision schema and its example: rules for the output, no case data. */
const REPO = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const OUTPUT_RULES = [
  'schemas/final-decision.schema.json',
  'schemas/final-decision.example.md',
].map((file) => join(REPO, file));

/** `{ allowed, reason }` for a hook payload. Exported for tests. */
export function decide(payload, { root = REPO } = {}) {
  if (payload?.tool_name !== 'Read')
    return { allowed: false, reason: `${payload?.tool_name} 도구는 쓸 수 없다` };
  const requested = payload.tool_input?.file_path;
  if (typeof requested !== 'string') return { allowed: false, reason: 'file_path가 없다' };
  let real;
  try {
    // Resolve symlinks so a link inside cases/ cannot point at a seal.
    real = realpathSync(resolve(payload.cwd ?? process.cwd(), requested));
  } catch {
    return { allowed: false, reason: `${requested}: 읽을 수 없다` };
  }
  return CASE_FILE.test(relative(root, real)) || OUTPUT_RULES.includes(real)
    ? { allowed: true }
    : {
        allowed: false,
        reason:
          '블라인드 케이스 파일(cases/<case_id>.json)과 schemas/final-decision.* 만 읽을 수 있다',
      };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(input);
    } catch {
      payload = null;
    }
    const { allowed, reason } = decide(payload);
    if (!allowed) {
      process.stderr.write(`${reason}\n`);
      process.exitCode = 2;
    }
  });
}
