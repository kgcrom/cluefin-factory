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
import { parseFrontmatter, readEntry, splitEntry } from '../lib/journal.mjs';
import { schemaFindings } from '../lib/validate.mjs';
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
      const target = join(paths.restored, `${restored.decision_id}.md`);
      // Re-restoring the same case refreshes its file; another case landing on the
      // same decision_id would silently replace a judgment, so it is refused.
      if (existsSync(target)) {
        const existing = readEntry(target).data?.blind?.case_id;
        if (existing !== caseId)
          throw new Error(`${restored.decision_id}.md가 다른 케이스(${existing})의 판단이다`);
      }
      writeFileSync(target, text);
      results.push({ case_id: caseId, decision_id: restored.decision_id });
    } catch (error) {
      results.push({ case_id: caseId, error: error.message });
    }
  }
  return results;
}

/**
 * The judge's reply → `{ text, data }` or `{ error }`. Anything before the
 * opening `---` (a stray sentence) is dropped; the frontmatter must parse and,
 * restored against the seal, pass the decision schema.
 */
export function checkDecision(reply, seal, schemaPath) {
  const at = String(reply).search(/^---\r?\n/m);
  if (at === -1) return { error: 'frontmatter(---)가 없다' };
  const text = String(reply).slice(at);
  const parts = splitEntry(text);
  if (!parts) return { error: 'frontmatter 블록이 닫히지 않았다' };
  let data;
  try {
    data = parseFrontmatter(parts.frontmatter);
  } catch (error) {
    return { error: `YAML 파싱 실패: ${error.message}` };
  }
  let restored;
  try {
    restored = restoreDecision(data, seal, { decidedAt: '2000-01-01T00:00:00Z' });
  } catch (error) {
    return { error: error.message };
  }
  const findings = schemaFindings(restored, schemaPath);
  if (findings.length > 0) return { error: findings.map((f) => f.message).join('; ') };
  return { text, data };
}

/**
 * Judge every built case that has no decision yet, `concurrency` at a time.
 * `invoke(casePath, feedback)` runs the judge and resolves to its reply; a reply
 * that fails `checkDecision` is retried once with the errors as feedback, then
 * recorded as failed. Only valid decisions are written.
 */
export async function judgeCases(
  paths,
  { invoke, schemaPath, concurrency = 4, retries = 1, log = () => {} },
) {
  const manifest = readManifest(paths);
  mkdirSync(paths.decisions, { recursive: true });
  const pending = Object.entries(manifest.entries)
    .filter(([id, e]) => e.status === 'built' && !existsSync(join(paths.decisions, `${id}.md`)))
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id]) => id);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const caseId = pending[next];
      next += 1;
      const seal = readJson(join(paths.seals, `${caseId}.json`));
      const casePath = join(paths.cases, `${caseId}.json`);
      let feedback = null;
      let outcome;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        let reply;
        try {
          reply = await invoke(casePath, feedback);
        } catch (error) {
          outcome = { error: `실행 실패: ${error.message}` };
          break;
        }
        outcome = checkDecision(reply, seal, schemaPath);
        if (!outcome.error) break;
        feedback = outcome.error;
      }
      if (outcome.error) {
        results.push({ case_id: caseId, error: outcome.error });
        log(`failed ${caseId}: ${outcome.error}`);
      } else {
        writeFileSync(join(paths.decisions, `${caseId}.md`), outcome.text);
        results.push({ case_id: caseId, verdict: outcome.data.verdict });
        log(`judged ${caseId}: ${outcome.data.verdict}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}
