import { describe, expect, it, vi } from 'vitest';
import { buildCase } from '../scripts/blind/case.mjs';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { FACT_TABLES, openPit, rebuild } from '../scripts/pit/db.mjs';
import { createFetcher } from '../scripts/pit/fetch.mjs';
import { caseInputs } from '../scripts/pit/inputs.mjs';
import { AS_OF, DAYS, fakeCli, flag } from './helpers/fake-cluefin.mjs';

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

  it('달력이 있으면 거래일 없는 구간은 부르지 않는다', () => {
    const db = openPit(':memory:');
    const fetcher = createFetcher(db, { cli: fakeCli, clock });
    fetcher.index('0001', '20230601', '20240628');
    const cli = vi.fn(fakeCli);
    const rows = createFetcher(db, { cli, clock }).shortSales('005930', '20230701', '20240628');
    expect(rows).toHaveLength(DAYS.filter((d) => d >= '20230701' && d <= '20240628').length);
    expect(cli.mock.calls.length).toBe(Math.ceil(rows.length / 100));
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

describe('fillCase — 상장 전·거래 없는 as_of', () => {
  it('as_of에 거래가 없으면 수급·기술적 지표를 묻지 않는다', () => {
    const db = openPit(':memory:');
    // A stock that starts trading on 2024-03-04.
    const cli = vi.fn((args) => {
      const body = fakeCli(args);
      if (args[2] === 'period')
        return { ...body, data: body.data.filter((r) => r.stck_bsop_date >= '20240304') };
      return body;
    });
    const fetcher = createFetcher(db, { cli, clock });
    const early = fetcher.fillCase({
      symbol: '440110',
      asOf: '20231016',
      benchmarkCode: '1001',
      today: '20241231',
    });
    expect(early.untraded_on_as_of).toBe(true);
    expect(
      cli.mock.calls.some((call) => call[0][1] === 'analysis' || call[0][2] === 'technical'),
    ).toBe(false);

    cli.mockClear();
    fetcher.fillCase({
      symbol: '440110',
      asOf: '20240628',
      benchmarkCode: '1001',
      today: '20241231',
    });
    const flowCalls = cli.mock.calls.map((c) => c[0]).filter((a) => a[1] === 'analysis');
    expect(flowCalls.length).toBeGreaterThan(0);
    for (const args of flowCalls) expect(flag(args, '--start-date')).toBe('20240304');
  });
});
