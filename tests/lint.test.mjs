import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEntry } from '../scripts/lib/journal.mjs';
import {
  cutoffBoundary,
  daysBetween,
  expectedLeakageRisk,
  minStopWidth,
  runRules,
} from '../scripts/lib/rules.mjs';
import { lintEntry } from '../scripts/scorecard.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = (name) => join(ROOT, 'tests/fixtures', name);
const rules = (findings) => findings.map((f) => f.rule).sort();
const errors = (findings) => findings.filter((f) => f.severity === 'error');

describe('lintEntry', () => {
  it('통과하는 판단에는 error를 내지 않는다', () => {
    const findings = lintEntry(readEntry(fixture('valid-retro-seed.md')));
    expect(errors(findings)).toEqual([]);
  });

  it('2026-09-19 세션에서 실제로 낸 스키마 위반 2건을 잡는다', () => {
    const findings = lintEntry(readEntry(fixture('broken-retro-seed.md')));
    const messages = findings.filter((f) => f.rule === 'schema').map((f) => f.message);
    // data_as_of.financial: null — 스키마는 null을 허용하지 않는다
    expect(messages.some((m) => m.includes('/data_as_of/financial'))).toBe(true);
    // debate.winner: none — enum은 bull/bear/tie
    expect(messages.some((m) => m.includes('/debate/winner'))).toBe(true);
  });

  it('review_due·leakage_risk·일봉 단독 조건을 각각 잡는다', () => {
    const findings = lintEntry(readEntry(fixture('broken-retro-seed.md')));
    expect(rules(errors(findings))).toEqual(
      expect.arrayContaining(['invalidation_scale', 'leakage_risk', 'review_due']),
    );
  });

  it('frontmatter가 없으면 parse error 하나만 낸다', () => {
    const findings = lintEntry({ path: 'x.md', error: 'frontmatter 블록이 없다' });
    expect(findings).toEqual([
      { rule: 'parse', severity: 'error', message: 'frontmatter 블록이 없다' },
    ]);
  });
});

describe('leakage_risk', () => {
  const asOf = (iso) => Date.parse(`${iso}T00:00:00Z`);

  it('컷오프 말일로부터의 간격으로 등급을 나눈다', () => {
    // 스킬 문서가 예시로 못 박은 세 지점
    expect(expectedLeakageRisk(asOf('2026-06-19'))).toBe('high'); // 19일
    expect(expectedLeakageRisk(asOf('2026-07-19'))).toBe('medium'); // 49일
    expect(expectedLeakageRisk(asOf('2026-09-01'))).toBe('low'); // 93일
  });

  it('컷오프 이전이면 high다', () => {
    expect(expectedLeakageRisk(asOf('2026-04-01'))).toBe('high');
  });

  it('경계값 30일과 90일은 더 위험한 쪽에 붙는다', () => {
    expect(daysBetween(cutoffBoundary('2026-05'), asOf('2026-06-30'))).toBe(30);
    expect(expectedLeakageRisk(asOf('2026-06-30'))).toBe('high');
    expect(daysBetween(cutoffBoundary('2026-05'), asOf('2026-08-29'))).toBe(90);
    expect(expectedLeakageRisk(asOf('2026-08-29'))).toBe('medium');
  });
});

describe('손절폭', () => {
  it('horizon의 제곱근에 비례한다', () => {
    const atr = 1000;
    expect(minStopWidth(atr, 30) / atr).toBeCloseTo(1.5, 2);
    expect(minStopWidth(atr, 60) / atr).toBeCloseTo(2.12, 2);
    expect(minStopWidth(atr, 90) / atr).toBeCloseTo(2.6, 2);
    expect(minStopWidth(atr, 120) / atr).toBeCloseTo(3.0, 2);
  });

  it('ATR을 주면 최소폭 미달을 잡는다', () => {
    // 2026-06-19 buy 90일: 실제로 1.5 ATR로 잡아 4일 만에 조기 종료된 건
    const data = {
      decision_id: '2026-06-19-000000-01',
      verdict: 'buy',
      horizon_days: 90,
      review_due: '2026-09-17',
      reference: { price: 81300 },
      levels: { stop_loss: 73535, entry: {}, targets: [] },
      invalidation: [{ id: 'inv-1', statement: 'x', checkable: true, check_on: 'weekly' }],
    };
    const findings = runRules(data, { atr: 5176.8 });
    expect(rules(errors(findings))).toContain('stop_width');
    // 2.6 ATR로 넓히면 통과한다
    const widened = { ...data, levels: { ...data.levels, stop_loss: 81300 - 2.6 * 5176.8 } };
    expect(errors(runRules(widened, { atr: 5176.8 }))).toEqual([]);
  });

  it('손절폭이 기준가의 20%를 넘으면 watch가 아닌 한 error다', () => {
    const data = {
      decision_id: '2026-06-19-000000-01',
      verdict: 'buy',
      horizon_days: 90,
      review_due: '2026-09-17',
      reference: { price: 100000 },
      levels: { stop_loss: 79000, entry: {}, targets: [] },
      invalidation: [{ id: 'inv-1', statement: 'x', checkable: true, check_on: 'weekly' }],
    };
    expect(rules(errors(runRules(data)))).toContain('stop_cap');
    expect(errors(runRules({ ...data, verdict: 'watch' }))).toEqual([]);
  });
});
