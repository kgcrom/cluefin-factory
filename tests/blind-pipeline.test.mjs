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
import { buildCases, restoreAll, runPaths, writeRegistry } from '../scripts/blind/pipeline.mjs';
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
