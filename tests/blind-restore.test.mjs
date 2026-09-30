import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCase, sealHash } from '../scripts/blind/case.mjs';
import { RestoreError, restoreDecision } from '../scripts/blind/restore.mjs';
import { readEntry } from '../scripts/lib/journal.mjs';
import { scoreDecision } from '../scripts/lib/scoring.mjs';
import { schemaFindings } from '../scripts/lib/validate.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCHEMA = join(ROOT, 'schemas/final-decision.schema.json');
const series = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/series-383220.json'), 'utf8'));
const template = readEntry(join(ROOT, 'tests/fixtures/decisions/2026-07-10-383220-01.md')).data;

// 61 rows up to as_of, 22 trading days after it: enough for a 20-day horizon.
const AT = 60;
const AS_OF = series.prices[AT].date;
const REFERENCE = series.prices[AT].close;
const prices = series.prices.map((row, i) => ({ ...row, open: row.close, volume: 1000 + i }));
const TODAY = '20260919';

const { case: blindCase, seal } = buildCase(
  {
    caseId: 'qwertyuiopas',
    symbol: '383220',
    names: ['픽스처'],
    market: 'KOSPI',
    asOf: AS_OF,
    horizonDays: 20,
    benchmarkCode: '2001',
  },
  {
    prices: prices.slice(0, AT + 1),
    index: series.index.filter((row) => row.date <= AS_OF),
  },
);

/** One judgment, written once in case units and once in real prices. */
function judgment(unit, extra = {}) {
  const at = (ratio) => Math.round(ratio * unit * 100) / 100;
  return {
    ...template,
    horizon_days: 20,
    horizon_basis: 'trading',
    reference: { ...template.reference, price: at(1) },
    levels: {
      entry: { min: at(0.98), max: at(1.01) },
      stop_loss: at(0.95),
      targets: [{ price: at(1.1), weight: 1 }],
      risk_reward: 2,
    },
    invalidation: [
      {
        id: 'inv-1',
        statement: '종가가 기준가의 90% 아래',
        checkable: true,
        metric: 'price',
        op: '<',
        value: at(0.9),
        check_on: 'daily',
      },
      {
        id: 'inv-2',
        statement: '영업이익 역성장',
        checkable: true,
        metric: 'operating_profit_growth_yoy',
        op: '<',
        value: 0,
        check_on: 'quarterly',
      },
    ],
    ...extra,
  };
}

const blindDecision = judgment(100, {
  decision_id: '2000-01-01-BLIND-01',
  symbol: 'BLIND',
  name: 'BLIND',
  data_as_of: { price: '2000-01-01' },
  review_due: '2000-01-01',
  blind: { case_id: 'qwertyuiopas', generator_model: 'claude-opus-5-5' },
});
const realDecision = judgment(REFERENCE, {
  decision_id: `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6)}-383220-01`,
  data_as_of: { price: `${AS_OF.slice(0, 4)}-${AS_OF.slice(4, 6)}-${AS_OF.slice(6)}` },
});

describe('restoreDecision', () => {
  const restored = restoreDecision(blindDecision, seal);

  it('봉인으로 종목·날짜를 채우고 스키마를 통과한다', () => {
    expect(restored).toMatchObject({
      decision_id: realDecision.decision_id,
      symbol: '383220',
      name: '픽스처',
      market: 'KOSPI',
      data_as_of: realDecision.data_as_of,
      reference: { price: REFERENCE, adjusted: true },
      blind: {
        case_id: 'qwertyuiopas',
        seal_sha256: sealHash(seal),
        generator_model: 'claude-opus-5-5',
      },
    });
    expect(schemaFindings(restored, SCHEMA)).toEqual([]);
  });

  it('가격형 필드만 원 가격으로 되돌린다', () => {
    expect(restored.levels.stop_loss).toBeCloseTo(REFERENCE * 0.95, 1);
    expect(restored.levels.targets[0].price).toBeCloseTo(REFERENCE * 1.1, 1);
    expect(restored.invalidation[0].value).toBeCloseTo(REFERENCE * 0.9, 1);
    expect(restored.invalidation[1].value).toBe(0);
    expect(restored.levels.risk_reward).toBe(2);
  });

  it('review_due는 거래일 horizon의 달력 추정치다', () => {
    const due = Date.parse(restored.review_due) - Date.parse(restored.data_as_of.price);
    expect(due / 86_400_000).toBe(28);
  });

  it('입력을 바꾸지 않는다', () => {
    expect(blindDecision.symbol).toBe('BLIND');
    expect(blindDecision.levels.stop_loss).toBe(95);
  });

  it('케이스 → 판단 → 역변환 → 채점이 원 가격 판단의 채점과 같다', () => {
    const inputs = { ...series, today: TODAY };
    const fromBlind = scoreDecision(restored, inputs);
    expect(fromBlind.status).not.toBe('pending');
    expect(fromBlind).toEqual(scoreDecision(realDecision, inputs));
  });

  it('케이스 가격 × 봉인 배율 = 원 가격', () => {
    const factor = seal.reference_price / 100;
    for (const [i, row] of blindCase.prices.entries()) {
      expect(row.close * factor).toBeCloseTo(prices[i].close, -1);
    }
  });

  it('봉인이 다르거나 horizon이 어긋나면 거부한다', () => {
    expect(() => restoreDecision(blindDecision, { ...seal, case_id: 'zzzzzzzzzzzz' })).toThrow(
      RestoreError,
    );
    expect(() => restoreDecision({ ...blindDecision, horizon_days: 60 }, seal)).toThrow(/horizon/);
    expect(() => restoreDecision({ ...blindDecision, horizon_basis: 'calendar' }, seal)).toThrow(
      /trading/,
    );
    expect(() => restoreDecision({ ...blindDecision, blind: undefined }, seal)).toThrow(/case_id/);
  });
});
