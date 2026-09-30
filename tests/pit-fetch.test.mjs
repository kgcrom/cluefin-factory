import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildCase } from '../scripts/blind/case.mjs';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { FACT_TABLES, openPit, rebuild } from '../scripts/pit/db.mjs';
import { createFetcher, shiftDays } from '../scripts/pit/fetch.mjs';
import { caseInputs } from '../scripts/pit/inputs.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const technicalFixture = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/technical-005930-20240628.json'), 'utf8'),
);

// Weekdays of 2023-06 … 2024-12 stand in for the exchange calendar.
const DAYS = [];
for (let d = '20230601'; d <= '20241231'; d = shiftDays(d, 1)) {
  const weekday = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`).getUTCDay();
  if (weekday !== 0 && weekday !== 6) DAYS.push(d);
}
const AS_OF = '20240628';
const closeOn = (date) => (date === AS_OF ? 81500 : 80000 + (DAYS.indexOf(date) % 7) * 100);

function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** The newest 100 rows of a window, newest first — how the four paged commands answer. */
const window = (from, to) =>
  DAYS.filter((d) => d >= from && d <= to)
    .slice(-100)
    .reverse();

/** A fake cluefin CLI over the synthetic calendar. */
function fakeCli(args) {
  const path = args.slice(0, 3).join(' ');
  if (path === 'kis chart period') {
    return {
      stock_code: flag(args, '--stock-code'),
      summary: { stck_prpr: '999999' },
      data: window(flag(args, '--start-date'), flag(args, '--end-date')).map((d) => ({
        stck_bsop_date: d,
        stck_oprc: String(closeOn(d)),
        stck_hgpr: String(closeOn(d) + 500),
        stck_lwpr: String(closeOn(d) - 500),
        stck_clpr: String(closeOn(d)),
        acml_vol: '1000000',
        acml_tr_pbmn: '80000000000',
      })),
    };
  }
  if (path === 'kis sector daily') {
    return {
      data: window('00000000', flag(args, '--start-date')).map((d) => ({
        stck_bsop_date: d,
        bstp_nmix_prpr: (2700 + (DAYS.indexOf(d) % 11)).toFixed(2),
      })),
    };
  }
  if (path === 'kiwoom analysis institutional-trend') {
    return {
      stk_orgn_trde_trnsn: window(flag(args, '--start-date'), flag(args, '--end-date')).map(
        (d) => ({
          dt: d,
          close_pric: `-${closeOn(d)}`,
          for_daly_nettrde_qty: '100000',
          orgn_daly_nettrde_qty: '-50000',
        }),
      ),
    };
  }
  if (path === 'kis analysis short-selling-trend') {
    return {
      data: window(flag(args, '--start-date'), flag(args, '--end-date')).map((d) => ({
        stck_bsop_date: d,
        ssts_cntg_qty: '20000',
      })),
    };
  }
  if (path === 'kis chart technical') {
    return { ...technicalFixture, as_of: flag(args, '--end-date'), candle_count: 120 };
  }
  throw new Error(`fake CLI: ${args.join(' ')}`);
}

const clock = () => '2026-09-30T00:00:00Z';

describe('createFetcher', () => {
  it('100행 상한을 뒤로 페이징해 구간을 다 채운다', () => {
    const db = openPit(':memory:');
    const cli = vi.fn(fakeCli);
    const rows = createFetcher(db, { cli, clock }).prices('005930', '20230701', '20240628');
    const expected = DAYS.filter((d) => d >= '20230701' && d <= '20240628');
    expect(rows.map((row) => row.date)).toEqual(expected);
    // 07-01 is a Saturday: the last page still starts after `from`, so pageBackwards
    // asks once more and stops on the empty answer.
    expect(cli.mock.calls.length).toBe(Math.ceil(expected.length / 100) + 1);
    expect(db.prepare('SELECT count(*) AS n FROM prices').get().n).toBe(expected.length);
    expect(db.prepare('SELECT count(*) AS n FROM raw').get().n).toBe(cli.mock.calls.length);
  });

  it('sector daily는 --start-date에 끝 날짜를 넘긴다', () => {
    const db = openPit(':memory:');
    const cli = vi.fn(fakeCli);
    createFetcher(db, { cli, clock }).index('2001', '20240401', '20240628');
    expect(flag(cli.mock.calls[0][0], '--start-date')).toBe('20240628');
  });

  it('rate limit·재시도 가능 오류만 백오프로 다시 부른다', () => {
    const db = openPit(':memory:');
    const sleep = vi.fn();
    let failures = 2;
    const flaky = (args) => {
      if (failures-- > 0) throw new CluefinError(5, 'rate limited');
      return fakeCli(args);
    };
    createFetcher(db, { cli: flaky, clock, sleep }).technical('005930', AS_OF);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);

    const fatal = () => {
      throw new CluefinError(3, 'no credentials');
    };
    expect(() =>
      createFetcher(db, { cli: fatal, clock, sleep }).technical('005930', AS_OF),
    ).toThrow(/exit 3/);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('재시도에도 계속 실패하면 네 번째에서 던진다', () => {
    const db = openPit(':memory:');
    const always = () => {
      throw new CluefinError(4, '{"retryable": true}');
    };
    const sleep = vi.fn();
    expect(() =>
      createFetcher(db, { cli: always, clock, sleep }).technical('005930', AS_OF),
    ).toThrow(CluefinError);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

describe('fillCase → caseInputs → buildCase', () => {
  const db = openPit(':memory:');
  const fetched = createFetcher(db, { cli: fakeCli, clock }).fillCase({
    symbol: '005930',
    asOf: AS_OF,
    benchmarkCode: '2001',
    horizonDays: 120,
    today: '20241231',
  });
  const inputs = caseInputs(db, { symbol: '005930', asOf: AS_OF, benchmarkCode: '2001' });

  it('가격은 horizon 끝까지 받지만 케이스 입력은 as_of에서 끊긴다', () => {
    expect(fetched.prices).toBeGreaterThan(fetched.flows);
    expect(db.prepare('SELECT max(date) AS d FROM prices').get().d > AS_OF).toBe(true);
    expect(inputs.prices).toHaveLength(120);
    expect(inputs.prices.at(-1).date).toBe(AS_OF);
    for (const block of [inputs.prices, inputs.index, inputs.flows]) {
      expect(block.every((row) => row.date <= AS_OF)).toBe(true);
    }
  });

  it('수급과 공매도가 날짜로 합쳐진다', () => {
    expect(inputs.flows.at(-1)).toEqual({
      date: AS_OF,
      foreign_net_qty: 100000,
      institution_net_qty: -50000,
      short_qty: 20000,
    });
  });

  it('아직 없는 블록은 null — "없음"이 아니라 "안 실음"', () => {
    expect(inputs).toMatchObject({ financials: null, disclosures: null, opinions: null });
  });

  it('저장소에서 꺼낸 입력으로 블라인드 케이스가 만들어진다', () => {
    const { case: blind } = buildCase(
      {
        caseId: 'zxcvbnmasdfg',
        symbol: '005930',
        names: ['삼성전자'],
        market: 'KOSPI',
        asOf: AS_OF,
        horizonDays: 120,
        benchmarkCode: '2001',
      },
      inputs,
    );
    expect(blind.prices).toHaveLength(120);
    expect(blind.flows.at(-1)).toEqual({
      d: 0,
      foreign_net_pct: 10,
      institution_net_pct: -5,
      short_pct: 2,
    });
    expect(blind.technical.signal.rules.length).toBeGreaterThan(0);
  });

  it('rebuild해도 같은 입력이 나온다', () => {
    const before = FACT_TABLES.map((t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
    rebuild(db);
    const after = FACT_TABLES.map((t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
    expect(after).toEqual(before);
    expect(caseInputs(db, { symbol: '005930', asOf: AS_OF, benchmarkCode: '2001' })).toEqual(
      inputs,
    );
  });

  it('휴장일 as_of에는 technical을 대신 채우지 않는다', () => {
    expect(
      caseInputs(db, { symbol: '005930', asOf: '20240629', benchmarkCode: '2001' }).technical,
    ).toBeNull();
  });
});
