#!/usr/bin/env node
/**
 * Deterministic half of the decision-scorecard pipeline.
 *
 * Usage:
 *   node scripts/scorecard.mjs lint [경로...] [--cutoff YYYY-MM] [--json]
 *
 * `lint` is read-only and makes no network calls. Paths default to
 * `.claude/investments/journal/*.md`, which is git-ignored per-user data.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEntry } from './lib/journal.mjs';
import { DEFAULT_CUTOFF, runRules } from './lib/rules.mjs';
import { schemaFindings } from './lib/validate.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_JOURNAL = join(ROOT, '.claude/investments/journal');
const SCHEMA = join(ROOT, 'schemas/final-decision.schema.json');

function parseArgs(argv) {
  const paths = [];
  const options = { cutoff: DEFAULT_CUTOFF, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cutoff') {
      i += 1;
      options.cutoff = argv[i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  return { paths, options };
}

function expandPaths(paths) {
  const targets = paths.length > 0 ? paths : [DEFAULT_JOURNAL];
  return targets.flatMap((target) => {
    const full = resolve(target);
    if (!statSync(full).isDirectory()) return [full];
    return readdirSync(full)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(full, name));
  });
}

/** Lint one already-read entry. Exported for tests. */
export function lintEntry(entry, options = {}) {
  if (entry.error) {
    return [{ rule: 'parse', severity: 'error', message: entry.error }];
  }
  return [
    ...schemaFindings(entry.data, options.schema ?? SCHEMA),
    ...runRules(entry.data, options),
  ];
}

export function lint(paths, options = {}) {
  return expandPaths(paths).map((path) => ({
    path,
    findings: lintEntry(readEntry(path), options),
  }));
}

const SEVERITY_MARK = { error: '✗', warn: '!', info: '·' };

function report(results, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const { path, findings } of results) {
      const relative = path.replace(`${ROOT}/`, '');
      if (findings.length === 0) {
        process.stdout.write(`  ok  ${relative}\n`);
        continue;
      }
      process.stdout.write(`      ${relative}\n`);
      for (const { rule, severity, message } of findings) {
        process.stdout.write(`   ${SEVERITY_MARK[severity] ?? '?'}  [${rule}] ${message}\n`);
      }
    }
  }
  return results.some(({ findings }) => findings.some((f) => f.severity === 'error')) ? 1 : 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'lint') {
    process.stderr.write('usage: scorecard.mjs lint [경로...] [--cutoff YYYY-MM] [--json]\n');
    return 2;
  }
  const { paths, options } = parseArgs(rest);
  return report(lint(paths, options), options);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
