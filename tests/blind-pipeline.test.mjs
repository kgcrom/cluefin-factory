import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCases,
  forkRun,
  judgeCases,
  restoreAll,
  runPaths,
  writeRegistry,
} from '../scripts/blind/pipeline.mjs';
import { createRegistry } from '../scripts/blind/sample.mjs';
import { readEntry } from '../scripts/lib/journal.mjs';
import { schemaFindings } from '../scripts/lib/validate.mjs';
import { openPit } from '../scripts/pit/db.mjs';
import { createFetcher } from '../scripts/pit/fetch.mjs';
import { DAYS, fakeCli } from './helpers/fake-cluefin.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCHEMA = join(ROOT, 'schemas/final-decision.schema.json');
const universe = [
  { symbol: '005930', name: '가나전자', market: 'KOSPI' },
  { symbol: '247540', name: '다라바이오', market: 'KOSDAQ' },
];

function setup(count = 3) {
  const paths = runPaths(mkdtempSync(join(tmpdir(), 'blind-')), 'pilot');
  const registry = createRegistry({
    name: 'pilot',
    universe,
    universeSource: 'fixture',
    calendar: DAYS,
    // Late enough that 120 sessions of history exist in the fake calendar.
    from: '20160104',
    to: '20240315',
    seed: 5,
    count,
    createdAt: '2026-09-30T00:00:00Z',
  });
  writeRegistry(paths, registry);
  const db = openPit(':memory:');
  const cli = vi.fn(fakeCli);
  const fetcher = createFetcher(db, { cli, clock: () => '2026-09-30T00:00:00Z' });
  return { paths, registry, db, cli, fetcher };
}

describe('buildCases', () => {
  it('등록 순서대로 count건을 만들고 케이스와 봉인을 나눠 쓴다', () => {
    const { paths, registry, db, fetcher } = setup();
    const result = buildCases(paths, { db, fetcher, today: '20241231' });
    expect(result).toMatchObject({ built: 3, target: 3 });
    const built = registry.candidates.slice(0, 3).map((c) => `${c.case_id}.json`);
    expect(readdirSync(paths.cases).sort()).toEqual([...built].sort());
    expect(readdirSync(paths.seals).sort()).toEqual([...built].sort());
    const blindCase = JSON.parse(readFileSync(join(paths.cases, built[0]), 'utf8'));
    expect(JSON.stringify(blindCase)).not.toMatch(/가나전자|다라바이오|005930|247540/);
  });

  it('중단 후 다시 돌리면 이어서 한다 — 이미 정한 후보는 다시 부르지 않는다', () => {
    const { paths, db, fetcher, cli } = setup();
    buildCases(paths, { db, fetcher, today: '20241231' });
    const calls = cli.mock.calls.length;
    expect(buildCases(paths, { db, fetcher, today: '20241231' }).built).toBe(3);
    expect(cli.mock.calls.length).toBe(calls);
  });

  it('케이스가 안 되는 후보는 사유와 함께 excluded, 다음 후보가 채운다', () => {
    const { paths, registry, db } = setup(2);
    const first = registry.candidates[0];
    // The first candidate's technical reading comes back for another day.
    const cli = (args) => {
      const body = fakeCli(args);
      if (args[2] === 'technical' && args.includes(first.symbol) && args.includes(first.as_of)) {
        return { ...body, close: body.close * 2 };
      }
      return body;
    };
    const result = buildCases(paths, {
      db,
      fetcher: createFetcher(db, { cli }),
      today: '20241231',
    });
    expect(result).toMatchObject({ built: 2, excluded: 1 });
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    expect(manifest.entries[first.case_id]).toMatchObject({ status: 'excluded' });
    expect(manifest.entries[first.case_id].reason).toMatch(/technical/);
    expect(existsSync(join(paths.cases, `${first.case_id}.json`))).toBe(false);
  });

  it('사전 등록은 두 번 쓰지 못한다', () => {
    const { paths, registry } = setup();
    expect(() => writeRegistry(paths, registry)).toThrow(/한 번만/);
  });
});

describe('restoreAll', () => {
  it('판단(케이스 단위)을 봉인으로 되돌려 스키마를 통과하는 파일로 쓴다', () => {
    const { paths, db, fetcher, registry } = setup(1);
    buildCases(paths, { db, fetcher, today: '20241231' });
    const candidate = registry.candidates[0];
    const blindCase = JSON.parse(
      readFileSync(join(paths.cases, `${candidate.case_id}.json`), 'utf8'),
    );
    const decision = {
      schema_version: 1,
      decision_id: '2000-01-01-BLIND-01',
      decided_at: '2000-01-01T00:00:00+09:00',
      supersedes: null,
      data_as_of: { price: '2000-01-01' },
      market: blindCase.market,
      symbol: 'BLIND',
      name: 'BLIND',
      verdict: 'buy',
      confidence: 'medium',
      horizon_days: blindCase.horizon_days,
      horizon_basis: 'trading',
      review_due: '2000-01-01',
      reference: { price: 100, currency: 'KRW', price_type: 'close', adjusted: true },
      levels: { entry: { min: 98, max: 101 }, stop_loss: 90, targets: [{ price: 115, weight: 1 }] },
      thesis: '합성 판단',
      biggest_risk: '합성 리스크',
      invalidation: [
        {
          id: 'inv-1',
          statement: '손절',
          checkable: true,
          metric: 'price',
          op: '<',
          value: 90,
          check_on: 'daily',
        },
      ],
      gates: { data_sanity: 'pass' },
      skills_run: ['technical-analysis', 'final-decision'],
      scoring: { status: 'pending' },
      blind: { case_id: blindCase.case_id },
    };
    mkdirSync(paths.decisions, { recursive: true });
    writeFileSync(
      join(paths.decisions, `${blindCase.case_id}.md`),
      `---\n${dump(decision)}---\n\n본문\n`,
    );
    writeFileSync(
      join(paths.decisions, 'zzzzzzzzzzzz.md'),
      `---\n${dump({ ...decision, blind: { case_id: 'zzzzzzzzzzzz' } })}---\n`,
    );

    const results = restoreAll(paths, { generatorModel: 'claude-opus-5-5' });
    const ok = results.find((r) => r.case_id === blindCase.case_id);
    expect(ok.decision_id).toMatch(new RegExp(`-${candidate.symbol}-01$`));
    expect(results.find((r) => r.case_id === 'zzzzzzzzzzzz').error).toMatch(/봉인/);

    const restored = readEntry(join(paths.restored, `${ok.decision_id}.md`));
    expect(schemaFindings(restored.data, SCHEMA)).toEqual([]);
    expect(restored.data).toMatchObject({
      symbol: candidate.symbol,
      blind: { case_id: blindCase.case_id, generator_model: 'claude-opus-5-5' },
    });
    expect(restored.body).toContain('본문');
  });
});

describe('judgeCases', () => {
  /** A valid judge reply for a case, in case units. */
  function reply(blindCase, overrides = {}) {
    const data = {
      schema_version: 1,
      decision_id: '2000-01-01-BLIND-01',
      decided_at: '2000-01-01T00:00:00+09:00',
      supersedes: null,
      data_as_of: { price: '2000-01-01' },
      market: blindCase.market,
      symbol: 'BLIND',
      name: 'BLIND',
      verdict: 'watch',
      confidence: 'low',
      horizon_days: blindCase.horizon_days,
      horizon_basis: 'trading',
      review_due: '2000-01-01',
      reference: { price: 100, currency: 'KRW', price_type: 'close', adjusted: true },
      thesis: '합성',
      biggest_risk: '합성',
      invalidation: [
        {
          id: 'inv-1',
          statement: 's',
          checkable: true,
          metric: 'price',
          op: '<',
          value: 90,
          check_on: 'weekly',
        },
      ],
      gates: { data_sanity: 'pass' },
      skills_run: ['technical-analysis'],
      scoring: { status: 'pending' },
      blind: { case_id: blindCase.case_id },
      ...overrides,
    };
    return `판단 결과입니다.\n---\n${dump(data)}---\n\n본문\n`;
  }
  const schemaPath = SCHEMA;
  const readCase = (paths, file) => JSON.parse(readFileSync(join(paths.cases, file), 'utf8'));

  it('유효한 답만 저장하고, 앞의 군말은 버린다', async () => {
    const { paths, db, fetcher } = setup(2);
    buildCases(paths, { db, fetcher, today: '20241231' });
    const invoke = vi.fn(async (casePath) => reply(JSON.parse(readFileSync(casePath, 'utf8'))));
    const results = await judgeCases(paths, { invoke, schemaPath, concurrency: 2 });
    expect(results.every((r) => r.verdict === 'watch')).toBe(true);
    const files = readdirSync(paths.decisions);
    expect(files).toHaveLength(2);
    const text = readFileSync(join(paths.decisions, files[0]), 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    // Already judged cases are not run again.
    await judgeCases(paths, { invoke, schemaPath });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('스키마에 없는 필드를 쓰면 오류를 붙여 한 번 다시 시키고, 또 틀리면 저장하지 않는다', async () => {
    const { paths, db, fetcher } = setup(1);
    buildCases(paths, { db, fetcher, today: '20241231' });
    const [file] = readdirSync(paths.cases);
    const blindCase = readCase(paths, file);
    const feedbacks = [];
    const bad = reply(blindCase, { levels: { stop: 92 } });
    const invoke = vi.fn(async (_path, feedback) => {
      feedbacks.push(feedback);
      return feedbacks.length === 1 ? bad : reply(blindCase);
    });
    expect(await judgeCases(paths, { invoke, schemaPath })).toEqual([
      { case_id: blindCase.case_id, verdict: 'watch' },
    ]);
    expect(feedbacks[0]).toBeNull();
    expect(feedbacks[1]).toMatch(/additional properties \(stop\)/);

    const again = setup(1);
    buildCases(again.paths, { db: again.db, fetcher: again.fetcher, today: '20241231' });
    const [other] = readdirSync(again.paths.cases);
    const alwaysBad = async () => reply(readCase(again.paths, other), { horizon_days: 7 });
    const [result] = await judgeCases(again.paths, { invoke: alwaysBad, schemaPath });
    expect(result.error).toMatch(/horizon_days/);
    expect(existsSync(again.paths.decisions) && readdirSync(again.paths.decisions)).toEqual([]);
  });

  it('판단기 실행이 실패하면 그 케이스만 실패로 남긴다', async () => {
    const { paths, db, fetcher } = setup(1);
    buildCases(paths, { db, fetcher, today: '20241231' });
    const invoke = async () => {
      throw new Error('claude exit 1');
    };
    const [result] = await judgeCases(paths, { invoke, schemaPath });
    expect(result.error).toMatch(/실행 실패/);
  });
});

describe('restoreAll 충돌', () => {
  it('다른 케이스의 판단 파일을 덮어쓰지 않는다', () => {
    const { paths, db, fetcher } = setup(1);
    buildCases(paths, { db, fetcher, today: '20241231' });
    const [file] = readdirSync(paths.cases);
    const blindCase = JSON.parse(readFileSync(join(paths.cases, file), 'utf8'));
    const seal = JSON.parse(readFileSync(join(paths.seals, file), 'utf8'));
    const data = {
      schema_version: 1,
      decision_id: '2000-01-01-BLIND-01',
      decided_at: '2000-01-01T00:00:00+09:00',
      supersedes: null,
      data_as_of: { price: '2000-01-01' },
      market: blindCase.market,
      symbol: 'BLIND',
      name: 'BLIND',
      verdict: 'watch',
      confidence: 'low',
      horizon_days: blindCase.horizon_days,
      horizon_basis: 'trading',
      review_due: '2000-01-01',
      reference: { price: 100, currency: 'KRW', price_type: 'close', adjusted: true },
      thesis: 't',
      biggest_risk: 'r',
      invalidation: [{ id: 'inv-1', statement: 's', checkable: false }],
      gates: { data_sanity: 'pass' },
      skills_run: ['technical-analysis'],
      scoring: { status: 'pending' },
      blind: { case_id: blindCase.case_id },
    };
    mkdirSync(paths.decisions, { recursive: true });
    writeFileSync(join(paths.decisions, file.replace('.json', '.md')), `---\n${dump(data)}---\n`);
    const [first] = restoreAll(paths);
    expect(first.decision_id).toBeTruthy();
    // Same case again: refreshed, not refused.
    expect(restoreAll(paths)[0].error).toBeUndefined();
    // Another case claiming the same decision_id: refused.
    const target = join(paths.restored, `${first.decision_id}.md`);
    writeFileSync(
      target,
      readFileSync(target, 'utf8').replace(
        `case_id: ${blindCase.case_id}`,
        'case_id: zzzzzzzzzzzz',
      ),
    );
    expect(restoreAll(paths)[0].error).toMatch(/다른 케이스/);
    expect(seal.symbol).toBeTruthy();
  });
});

describe('forkRun + 고정 청산 규칙', () => {
  it('같은 케이스·봉인으로 새 실행을 만들고, 판단은 규칙 검사를 통과해야 저장된다', async () => {
    const { paths, db, fetcher } = setup(1);
    buildCases(paths, { db, fetcher, today: '20241231' });
    const forked = runPaths(join(paths.base, '..'), 'pilot-sl8-tp24');
    expect(forkRun(paths, forked, { stop_pct: 8, target_pct: 24 })).toMatchObject({ cases: 1 });
    expect(readdirSync(forked.cases)).toEqual(readdirSync(paths.cases));
    expect(readFileSync(forked.registry, 'utf8')).toBe(readFileSync(paths.registry, 'utf8'));
    expect(() => forkRun(paths, forked, { stop_pct: 8, target_pct: 24 })).toThrow(/이미/);

    const [file] = readdirSync(forked.cases);
    const blindCase = JSON.parse(readFileSync(join(forked.cases, file), 'utf8'));
    const base = {
      schema_version: 1,
      decision_id: '2000-01-01-BLIND-01',
      decided_at: '2000-01-01T00:00:00+09:00',
      supersedes: null,
      data_as_of: { price: '2000-01-01' },
      market: blindCase.market,
      symbol: 'BLIND',
      name: 'BLIND',
      confidence: 'low',
      horizon_days: blindCase.horizon_days,
      horizon_basis: 'trading',
      review_due: '2000-01-01',
      reference: { price: 100, currency: 'KRW', price_type: 'close', adjusted: true },
      thesis: 't',
      biggest_risk: 'r',
      gates: { data_sanity: 'pass' },
      skills_run: ['technical-analysis'],
      scoring: { status: 'pending' },
      blind: { case_id: blindCase.case_id },
    };
    const cond = (id, op, value) => ({
      id,
      statement: 's',
      checkable: true,
      metric: 'price',
      op,
      value,
      check_on: 'daily',
    });
    const bad = {
      ...base,
      verdict: 'buy',
      levels: { entry: { min: 99, max: 101 }, stop_loss: 90, targets: [{ price: 115, weight: 1 }] },
      invalidation: [cond('inv-1', '<', 90)],
    };
    const good = {
      ...bad,
      levels: { entry: { min: 99, max: 101 }, stop_loss: 92, targets: [{ price: 124, weight: 1 }] },
      invalidation: [cond('inv-1', '<', 92), cond('inv-2', '>=', 124)],
    };
    const seen = [];
    const invoke = async (_path, feedback, rules) => {
      seen.push({ feedback, rules });
      return `---\n${dump(seen.length === 1 ? bad : good)}---\n`;
    };
    const [result] = await judgeCases(forked, { invoke, schemaPath: SCHEMA });
    expect(result).toEqual({ case_id: blindCase.case_id, verdict: 'buy' });
    expect(seen[0].rules).toEqual({ stop_pct: 8, target_pct: 24 });
    expect(seen[1].feedback).toMatch(/stop_loss는 92/);
  });
});
