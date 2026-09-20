#!/usr/bin/env node
/**
 * Deterministic half of the decision-scorecard pipeline.
 *
 * Usage:
 *   node scripts/scorecard.mjs lint  [경로...] [--cutoff YYYY-MM] [--atr] [--json]
 *   node scripts/scorecard.mjs score [경로...] [--write] [--today YYYYMMDD] [--json]
 *   node scripts/scorecard.mjs aggregate [경로...] [--json]
 *
 * `lint` and `aggregate` are read-only, and offline unless `lint --atr` is given —
 * the minimum-stop-width rule needs the ATR of the judgment's own price date, which
 * only the candles have. `score` calls the cluefin CLI and prints;
 * it rewrites the `scoring` block only with `--write`.
 * Paths default to `.claude/investments/journal/*.md`, git-ignored per-user data.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from './lib/aggregate.mjs';
import { ATR_PERIOD, atr14, lookbackStart } from './lib/atr.mjs';
import { benchmarkFor, dailyCandles, sectorDailyRange } from './lib/cluefin.mjs';
import { readEntry } from './lib/journal.mjs';
import { DEFAULT_CUTOFF, runRules } from './lib/rules.mjs';
import { compact, scoreDecision } from './lib/scoring.mjs';
import { schemaFindings } from './lib/validate.mjs';
import { applyScoring, renderScoring } from './lib/write.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_JOURNAL = join(ROOT, '.claude/investments/journal');
const SCHEMA = join(ROOT, 'schemas/final-decision.schema.json');

/** Split argv into paths and options. Exported for tests. */
export function parseArgs(argv) {
  const paths = [];
  const options = { cutoff: DEFAULT_CUTOFF, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cutoff') {
      i += 1;
      options.cutoff = argv[i];
    } else if (arg === '--today') {
      i += 1;
      options.today = argv[i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--atr') {
      options.withAtr = true;
    } else if (arg === '--write') {
      options.write = true;
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

/**
 * Calendar days of candles to pull for one ATR reading: ATR_PERIOD trading days
 * plus slack for weekends and holidays, so the window is never short by a day.
 */
const ATR_LOOKBACK_DAYS = Math.ceil(ATR_PERIOD * 2) + 21;

/** ATR14 as of `data_as_of.price`. Hits the network — only `lint --atr` calls it. */
export function atrFor(data, options = {}) {
  const end = compact(String(data?.data_as_of?.price ?? ''));
  if (!/^\d{8}$/.test(end) || typeof data.symbol !== 'string') return null;
  const fetchCandles = options.fetchCandles ?? dailyCandles;
  return atr14(fetchCandles(data.symbol, lookbackStart(end, ATR_LOOKBACK_DAYS), end));
}

/** The stop-width minimum is unchecked without an ATR, so say so rather than pass silently. */
const atrMissing = (message) => ({ rule: 'atr', severity: 'warn', message });

function lintOne(path, options) {
  const entry = readEntry(path);
  if (!options.withAtr || entry.error) return { path, findings: lintEntry(entry, options) };
  let atr = null;
  try {
    atr = atrFor(entry.data, options);
  } catch (cause) {
    return {
      path,
      findings: [...lintEntry(entry, options), atrMissing(`ATR 조회 실패 — ${cause.message}`)],
    };
  }
  const findings = lintEntry(entry, { ...options, atr });
  return {
    path,
    findings:
      atr === null
        ? [...findings, atrMissing('ATR14을 구하지 못했다 — 최소 손절폭 검사를 건너뛴다')]
        : findings,
  };
}

export function lint(paths, options = {}) {
  return expandPaths(paths).map((path) => lintOne(path, options));
}

const todayCompact = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

/** Decisions still open, plus the ids that a newer decision has superseded. */
export function selectPending(entries) {
  const superseded = new Set(
    entries.map((entry) => entry.data?.supersedes).filter((id) => typeof id === 'string'),
  );
  return entries
    .filter((entry) => entry.data?.scoring?.status === 'pending')
    .map((entry) => ({
      entry,
      superseded: superseded.has(entry.data.decision_id),
    }));
}

export function score(paths, options = {}) {
  const today = options.today ?? todayCompact();
  const entries = expandPaths(paths).map((path) => readEntry(path));
  return selectPending(entries).map(({ entry, superseded }) => {
    const { data, path } = entry;
    if (superseded) {
      return { path, decision_id: data.decision_id, result: { status: 'superseded' } };
    }
    const referenceDate = compact(String(data.data_as_of.price));
    const end =
      compact(String(data.review_due)) <= today ? compact(String(data.review_due)) : today;
    const fetchPrices = options.fetchPrices ?? dailyCandles;
    const fetchIndex = options.fetchIndex ?? sectorDailyRange;
    const prices = fetchPrices(data.symbol, referenceDate, end);
    const index = fetchIndex(benchmarkFor(data.market), referenceDate, end);
    const result = scoreDecision(data, { prices, index, today });
    if (options.write && result.status !== 'pending') {
      const block = renderScoring(result, {
        scoredAt: options.scoredAt ?? new Date().toISOString(),
        referenceDate,
      });
      writeFileSync(path, applyScoring(entry.text, block));
    }
    return { path, decision_id: data.decision_id, written: Boolean(options.write), result };
  });
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

function reportScores(results) {
  for (const { decision_id, result } of results) {
    process.stdout.write(`  ${decision_id}\n`);
    for (const [key, value] of Object.entries(result)) {
      process.stdout.write(`    ${key}: ${JSON.stringify(value)}\n`);
    }
  }
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;
  const { paths, options } = parseArgs(rest);
  if (command === 'lint') return report(lint(paths, options), options);
  if (command === 'aggregate') {
    const groups = aggregate(expandPaths(paths).map((path) => readEntry(path)));
    process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
    return 0;
  }
  if (command === 'score') {
    const results = score(paths, options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      return 0;
    }
    return reportScores(results);
  }
  process.stderr.write(
    'usage: scorecard.mjs lint|score|aggregate [경로...] [--cutoff YYYY-MM] [--today YYYYMMDD] [--atr] [--write] [--json]\n',
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
