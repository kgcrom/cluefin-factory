import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { atr14, lookbackStart } from '../scripts/lib/atr.mjs';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { readEntry } from '../scripts/lib/journal.mjs';
import { minStopWidth, runRules } from '../scripts/lib/rules.mjs';
import { lint, lintEntry } from '../scripts/scorecard.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = (name) => join(ROOT, 'tests/fixtures', name);
const rules = (findings) => findings.map((f) => f.rule).sort();
const errors = (findings) => findings.filter((f) => f.severity === 'error');

describe('lintEntry', () => {
  it('통과하는 판단에는 error를 내지 않는다', () => {
    const findings = lintEntry(readEntry(fixture('valid-decision.md')));
    expect(errors(findings)).toEqual([]);
  });

  it('2026-09-19 세션에서 실제로 낸 스키마 위반 2건을 잡는다', () => {
    const findings = lintEntry(readEntry(fixture('broken-decision.md')));
    const messages = findings.filter((f) => f.rule === 'schema').map((f) => f.message);
    // data_as_of.financial: null — 스키마는 null을 허용하지 않는다
    expect(messages.some((m) => m.includes('/data_as_of/financial'))).toBe(true);
    // debate.winner: none — enum은 bull/bear/tie
    expect(messages.some((m) => m.includes('/debate/winner'))).toBe(true);
  });

  it('review_due·일봉 단독 조건을 각각 잡는다', () => {
    const findings = lintEntry(readEntry(fixture('broken-decision.md')));
    expect(rules(errors(findings))).toEqual(
      expect.arrayContaining(['invalidation_scale', 'review_due']),
    );
  });

  it('frontmatter가 없으면 parse error 하나만 낸다', () => {
    const findings = lintEntry({ path: 'x.md', error: 'frontmatter 블록이 없다' });
    expect(findings).toEqual([
      { rule: 'parse', severity: 'error', message: 'frontmatter 블록이 없다' },
    ]);
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

describe('ATR 배선', () => {
  // 등락폭 1000원이 고정된 캔들: TR이 매일 1000이므로 ATR14도 1000이다.
  const flatCandles = (count, range = 1000) =>
    Array.from({ length: count }, (_, i) => ({
      date: String(20260601 + i),
      close: 80000,
      high: 80000 + range / 2,
      low: 80000 - range / 2,
    }));

  it('Wilder 평균으로 ATR14을 낸다', () => {
    expect(atr14(flatCandles(30))).toBeCloseTo(1000, 6);
  });

  it('캔들이 15개 미만이면 null이다 — TR은 첫 봉을 못 쓴다', () => {
    expect(atr14(flatCandles(14))).toBeNull();
    expect(atr14(flatCandles(15))).not.toBeNull();
    expect(atr14([])).toBeNull();
  });

  it('고가·저가가 비면 0이 아니라 null이다', () => {
    const broken = flatCandles(30).map((row, i) => (i === 5 ? { ...row, high: null } : row));
    expect(atr14(broken)).toBeNull();
  });

  it('조회 구간은 판단의 price 기준일에서 뒤로 잡는다', () => {
    expect(lookbackStart('20260724', 49)).toBe('20260605');
  });

  it('--atr이 있어야 최소 손절폭을 검사한다', () => {
    const path = fixture('valid-decision.md');
    // 손절폭 7765원, horizon 40일 → 최소 1.73 ATR. ATR 5000원이면 미달이다.
    const fetchCandles = vi.fn(() => flatCandles(30, 5000));

    const offline = lint([path]);
    expect(rules(offline[0].findings)).not.toContain('stop_width');
    expect(fetchCandles).not.toHaveBeenCalled();

    const online = lint([path], { withAtr: true, fetchCandles });
    expect(rules(errors(online[0].findings))).toContain('stop_width');
    expect(fetchCandles).toHaveBeenCalledWith('000000', '20260605', '20260724');
  });

  it('ATR을 못 구하면 검사를 건너뛴 사실을 warn으로 남긴다', () => {
    const short = lint([fixture('valid-decision.md')], {
      withAtr: true,
      fetchCandles: () => [],
    });
    const skipped = short[0].findings.filter((f) => f.rule === 'atr');
    expect(skipped.map((f) => f.severity)).toEqual(['warn']);
    expect(rules(short[0].findings)).not.toContain('stop_width');
  });

  it('CLI가 실패해도 나머지 린트 결과는 살린다', () => {
    const failed = lint([fixture('valid-decision.md')], {
      withAtr: true,
      fetchCandles: () => {
        throw new CluefinError(5, 'rate limit');
      },
    });
    expect(failed[0].findings.some((f) => f.rule === 'atr' && f.message.includes('exit 5'))).toBe(
      true,
    );
    expect(errors(failed[0].findings)).toEqual([]);
  });
});
