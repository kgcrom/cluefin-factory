import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { atr14, lookbackStart } from '../scripts/lib/atr.mjs';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { readEntry } from '../scripts/lib/journal.mjs';
import {
  calendarSpan,
  cutoffBoundary,
  cutoffForModel,
  daysBetween,
  expectedLeakageRisk,
  minStopWidth,
  retroSeedBudget,
  runRules,
} from '../scripts/lib/rules.mjs';
import { lint, lintEntry } from '../scripts/scorecard.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = (name) => join(ROOT, 'tests/fixtures', name);
const rules = (findings) => findings.map((f) => f.rule).sort();
const errors = (findings) => findings.filter((f) => f.severity === 'error');
// 예산 규칙이 오늘을 읽으므로 픽스처 검사는 기준일을 못 박는다.
const TODAY = '20260920';

describe('lintEntry', () => {
  it('통과하는 판단에는 error를 내지 않는다', () => {
    const findings = lintEntry(readEntry(fixture('valid-retro-seed.md')), { today: TODAY });
    expect(errors(findings)).toEqual([]);
  });

  it('2026-09-19 세션에서 실제로 낸 스키마 위반 2건을 잡는다', () => {
    const findings = lintEntry(readEntry(fixture('broken-retro-seed.md')), { today: TODAY });
    const messages = findings.filter((f) => f.rule === 'schema').map((f) => f.message);
    // data_as_of.financial: null — 스키마는 null을 허용하지 않는다
    expect(messages.some((m) => m.includes('/data_as_of/financial'))).toBe(true);
    // debate.winner: none — enum은 bull/bear/tie
    expect(messages.some((m) => m.includes('/debate/winner'))).toBe(true);
  });

  it('review_due·leakage_risk·일봉 단독 조건을 각각 잡는다', () => {
    const findings = lintEntry(readEntry(fixture('broken-retro-seed.md')), { today: TODAY });
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

describe('컷오프는 모델에 딸린 값이다', () => {
  it('generator_model이 컷오프를 정하고, 없으면 기본값으로 떨어진다', () => {
    expect(cutoffForModel('claude-opus-5')).toBe('2026-05');
    expect(cutoffForModel(undefined)).toBe('2026-05');
    expect(cutoffForModel('claude-opus-5', '2025-01')).toBe('2026-05');
  });

  it('모르는 모델은 추측하지 않고 error를 낸다', () => {
    const data = {
      provenance: 'retro_seed',
      retro_seed: { as_of: '2026-07-24', generator_model: 'gpt-미래', leakage_risk: 'medium' },
    };
    const findings = runRules(data, { today: TODAY });
    expect(rules(errors(findings))).toContain('generator_model');
  });

  it('generator_model이 없으면 error가 아니라 warn이다', () => {
    const data = {
      provenance: 'retro_seed',
      retro_seed: { as_of: '2026-07-24', leakage_risk: 'medium' },
    };
    const findings = runRules(data, { today: TODAY });
    expect(errors(findings).map((f) => f.rule)).not.toContain('generator_model');
    expect(findings.some((f) => f.rule === 'generator_model' && f.severity === 'warn')).toBe(true);
  });
});

describe('retro seed 예산', () => {
  const seed = (overrides) => ({
    provenance: 'retro_seed',
    horizon_days: 20,
    horizon_basis: 'trading',
    retro_seed: {
      as_of: '2026-08-14',
      generator_model: 'claude-opus-5',
      leakage_risk: 'medium',
    },
    ...overrides,
  });

  it('거래일 horizon을 달력 일수로 환산한다', () => {
    expect(calendarSpan(20, 'trading')).toBe(28);
    expect(calendarSpan(40, 'trading')).toBe(56);
    expect(calendarSpan(60, 'trading')).toBe(84);
    expect(calendarSpan(30, 'calendar')).toBe(30);
  });

  it('컷오프가 허용하는 최대 horizon을 거래일로 낸다', () => {
    // 2026-05-31 + 31일 = 2026-07-01 부터 2026-09-20 까지 = 81일
    expect(retroSeedBudget('2026-05', TODAY)).toEqual({ calendar: 81, trading: 57 });
  });

  it('high 구간 as_of는 만들지 못하게 막는다', () => {
    const data = seed({
      retro_seed: {
        as_of: '2026-06-19',
        generator_model: 'claude-opus-5',
        leakage_risk: 'high',
      },
    });
    const messages = errors(runRules(data, { today: TODAY }))
      .filter((f) => f.rule === 'retro_seed_budget')
      .map((f) => f.message);
    expect(messages.some((m) => m.includes('high'))).toBe(true);
  });

  it('오늘 안에 끝나지 않는 horizon은 forward로 넘긴다', () => {
    // 거래일 60일 = 달력 84일. as_of 2026-07-01이면 2026-09-23에야 끝난다.
    const data = seed({
      horizon_days: 60,
      retro_seed: {
        as_of: '2026-07-01',
        generator_model: 'claude-opus-5',
        leakage_risk: 'medium',
      },
    });
    const messages = errors(runRules(data, { today: TODAY }))
      .filter((f) => f.rule === 'retro_seed_budget')
      .map((f) => f.message);
    expect(messages.some((m) => m.includes('forward'))).toBe(true);
  });

  it('예산 안에 드는 판단은 통과시킨다', () => {
    expect(
      errors(runRules(seed({}), { today: TODAY })).filter((f) => f.rule === 'retro_seed_budget'),
    ).toEqual([]);
  });

  it('forward 판단에는 예산 규칙을 적용하지 않는다', () => {
    const data = { provenance: 'forward', horizon_days: 200, horizon_basis: 'trading' };
    expect(runRules(data, { today: TODAY }).filter((f) => f.rule === 'retro_seed_budget')).toEqual(
      [],
    );
  });
});

describe('horizon 사다리', () => {
  it('사다리 밖 horizon과 달력 기준을 warn으로 짚는다', () => {
    const data = {
      provenance: 'retro_seed',
      horizon_days: 90,
      retro_seed: {
        as_of: '2026-07-24',
        generator_model: 'claude-opus-5',
        leakage_risk: 'medium',
      },
    };
    const warns = runRules(data, { today: TODAY }).filter((f) => f.rule === 'horizon_ladder');
    expect(warns).toHaveLength(2);
    expect(warns.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('20/40/60 거래일은 조용히 통과한다', () => {
    for (const horizon of [20, 40, 60]) {
      const data = {
        provenance: 'retro_seed',
        horizon_days: horizon,
        horizon_basis: 'trading',
        retro_seed: {
          as_of: '2026-07-24',
          generator_model: 'claude-opus-5',
          leakage_risk: 'medium',
        },
      };
      expect(runRules(data, { today: TODAY }).filter((f) => f.rule === 'horizon_ladder')).toEqual(
        [],
      );
    }
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
    const path = fixture('valid-retro-seed.md');
    // 손절폭 7765원, horizon 40일 → 최소 1.73 ATR. ATR 5000원이면 미달이다.
    const fetchCandles = vi.fn(() => flatCandles(30, 5000));

    const offline = lint([path], { today: TODAY });
    expect(rules(offline[0].findings)).not.toContain('stop_width');
    expect(fetchCandles).not.toHaveBeenCalled();

    const online = lint([path], { today: TODAY, withAtr: true, fetchCandles });
    expect(rules(errors(online[0].findings))).toContain('stop_width');
    expect(fetchCandles).toHaveBeenCalledWith('000000', '20260605', '20260724');
  });

  it('ATR을 못 구하면 검사를 건너뛴 사실을 warn으로 남긴다', () => {
    const short = lint([fixture('valid-retro-seed.md')], {
      today: TODAY,
      withAtr: true,
      fetchCandles: () => [],
    });
    const skipped = short[0].findings.filter((f) => f.rule === 'atr');
    expect(skipped.map((f) => f.severity)).toEqual(['warn']);
    expect(rules(short[0].findings)).not.toContain('stop_width');
  });

  it('CLI가 실패해도 나머지 린트 결과는 살린다', () => {
    const failed = lint([fixture('valid-retro-seed.md')], {
      today: TODAY,
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
