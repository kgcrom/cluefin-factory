/**
 * File layout and the build / restore steps of a blind run.
 *
 *   .claude/investments/blind/<run>/
 *     registry.json   pre-registered candidates (written once, hash-checked)
 *     manifest.json   per-candidate status: built | excluded (+ reason)
 *     cases/          <case_id>.json — the only thing the judge ever sees
 *     seals/          <case_id>.json — symbol, as_of, reference price
 *     decisions/      <case_id>.md   — the judge's output, in case units
 *     restored/       <decision_id>.md — real prices, scoreable by scorecard.mjs
 *
 * `cases/` and `seals/` are siblings on purpose: the judge is given one case's
 * content in its prompt and has no tools, so a path is never handed to it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { readEntry } from '../lib/journal.mjs';
import { caseInputs } from '../pit/inputs.mjs';
import { buildCase, CaseError } from './case.mjs';
import { restoreDecision } from './restore.mjs';
import { verifyRegistry } from './sample.mjs';

export function runPaths(root, run) {
  const base = join(root, run);
  return {
    base,
    registry: join(base, 'registry.json'),
    manifest: join(base, 'manifest.json'),
    cases: join(base, 'cases'),
    seals: join(base, 'seals'),
    decisions: join(base, 'decisions'),
    restored: join(base, 'restored'),
  };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function writeRegistry(paths, registry) {
  if (existsSync(paths.registry)) {
    throw new Error(`${paths.registry}가 이미 있다 — 사전 등록은 한 번만 쓴다`);
  }
  mkdirSync(paths.base, { recursive: true });
  writeJson(paths.registry, registry);
}

export function readManifest(paths) {
  return existsSync(paths.manifest) ? readJson(paths.manifest) : { entries: {} };
}

/**
 * Walk the registry in order and turn candidates into cases until `count` are
 * built. Already-decided candidates are skipped, so an interrupted run resumes.
 * A case the builder refuses (short history, missing technical reading) is
 * excluded with the reason; a CLI failure stops the run instead — that is not
 * a property of the candidate.
 */
export function buildCases(paths, { db, fetcher, today, log = () => {} }) {
  const registry = verifyRegistry(readJson(paths.registry));
  const manifest = readManifest(paths);
  for (const dir of [paths.cases, paths.seals]) mkdirSync(dir, { recursive: true });
  const built = () => Object.values(manifest.entries).filter((e) => e.status === 'built').length;

  for (const candidate of registry.candidates) {
    if (built() >= registry.count) break;
    if (manifest.entries[candidate.case_id]) continue;
    const { case_id: caseId, symbol, as_of: asOf, benchmark_code: benchmarkCode } = candidate;
    fetcher.fillCase({ symbol, asOf, benchmarkCode, horizonDays: candidate.horizon_days, today });
    try {
      const { case: blindCase, seal } = buildCase(
        {
          caseId,
          symbol,
          names: [candidate.name],
          market: candidate.market,
          asOf,
          horizonDays: candidate.horizon_days,
          benchmarkCode,
          sources: [
            'kis.chart.period',
            'kis.sector.daily',
            'kiwoom.analysis.institutional-trend',
            'kis.analysis.short-selling-trend',
            'kis.chart.technical',
          ],
        },
        caseInputs(db, { symbol, asOf, benchmarkCode }),
      );
      writeJson(join(paths.cases, `${caseId}.json`), blindCase);
      writeJson(join(paths.seals, `${caseId}.json`), seal);
      manifest.entries[caseId] = { order: candidate.order, status: 'built' };
      log(`built ${candidate.order} ${caseId}`);
    } catch (error) {
      if (!(error instanceof CaseError)) throw error;
      manifest.entries[caseId] = {
        order: candidate.order,
        status: 'excluded',
        reason: error.message,
      };
      log(`excluded ${candidate.order} ${caseId}: ${error.message}`);
    }
    writeJson(paths.manifest, manifest);
  }
  return {
    built: built(),
    target: registry.count,
    excluded: Object.values(manifest.entries).filter((e) => e.status === 'excluded').length,
  };
}

/**
 * Restore every judged case to real prices. A decision whose seal is missing
 * or does not match is reported, not written.
 */
export function restoreAll(paths, { generatorModel } = {}) {
  mkdirSync(paths.restored, { recursive: true });
  const results = [];
  const files = existsSync(paths.decisions)
    ? readdirSync(paths.decisions).filter((f) => f.endsWith('.md'))
    : [];
  for (const file of files.sort()) {
    const caseId = file.replace(/\.md$/, '');
    const entry = readEntry(join(paths.decisions, file));
    const sealPath = join(paths.seals, `${caseId}.json`);
    try {
      if (entry.error) throw new Error(entry.error);
      if (!existsSync(sealPath)) throw new Error('봉인 파일이 없다');
      const restored = restoreDecision(entry.data, readJson(sealPath), { generatorModel });
      const text = `---\n${dump(restored, { lineWidth: 120, quotingType: '"' })}---\n${entry.body}`;
      writeFileSync(join(paths.restored, `${restored.decision_id}.md`), text);
      results.push({ case_id: caseId, decision_id: restored.decision_id });
    } catch (error) {
      results.push({ case_id: caseId, error: error.message });
    }
  }
  return results;
}
