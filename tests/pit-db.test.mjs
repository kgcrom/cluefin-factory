import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  disclosuresAsOf,
  FACT_TABLES,
  financialsAsOf,
  financialsLatest,
  indexAsOf,
  ingest,
  loadFacts,
  migrate,
  migrations,
  openPit,
  PitError,
  pricesAsOf,
  rebuild,
  tradingCalendar,
} from '../scripts/pit/db.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = (name) => readFileSync(join(ROOT, 'tests/fixtures/pit', name), 'utf8');

const SECTOR = {
  source: 'kis.sector.daily',
  params: { sector_code: '0001', start_date: '20240628' },
  body: fixture('kis-sector-daily-0001-20240628.json'),
  fetchedAt: '2026-09-30T13:00:00Z',
};
const PERIOD = {
  source: 'kis.chart.period',
  params: { stock_code: '005930', start_date: '20240201', end_date: '20240628' },
  body: fixture('kis-chart-period-005930-20240628.json'),
  fetchedAt: '2026-09-30T13:01:00Z',
};
const DISCLOSURES = {
  source: 'dart.disclosure-search',
  params: { corp_code: '00126380', bgn_de: '20240601', end_de: '20240628' },
  body: fixture('dart-disclosure-search-00126380-202406.json'),
  fetchedAt: '2026-09-30T13:02:00Z',
};
/** One more session, so filings of 06-28 get a known_at. */
const JULY = {
  source: 'kis.sector.daily',
  params: { sector_code: '0001', start_date: '20240701' },
  body: JSON.stringify({ data: [{ stck_bsop_date: '20240701', bstp_nmix_prpr: '2804.31' }] }),
  fetchedAt: '2026-09-30T13:03:00Z',
};

const fresh = () => openPit(':memory:');

function dump(db) {
  return Object.fromEntries(
    FACT_TABLES.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

describe('마이그레이션', () => {
  it('새 DB는 최신 버전까지 올라가고, 다시 열어도 그대로다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pit-'));
    const path = join(dir, 'pit.sqlite');
    const latest = migrations().at(-1).version;
    const first = openPit(path);
    expect(first.prepare('PRAGMA user_version').get().user_version).toBe(latest);
    first.close();
    const again = openPit(path);
    expect(migrate(again)).toBe(latest);
    again.close();
  });

  it('코드보다 새 버전의 DB는 열지 않는다', () => {
    const db = fresh();
    db.exec('PRAGMA user_version = 999');
    expect(() => migrate(db)).toThrow(PitError);
  });

  it('실패한 마이그레이션은 버전을 올리지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pit-mig-'));
    writeFileSync(join(dir, '001-ok.sql'), 'CREATE TABLE a (x INTEGER) STRICT;');
    writeFileSync(join(dir, '002-bad.sql'), 'CREATE TABLE b (x INTEGER) STRICT; NOT SQL;');
    const db = openPit(':memory:');
    db.exec('PRAGMA user_version = 0');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1);
  });
});

describe('적재', () => {
  it('KIS summary(조회 당일 값)는 싣지 않는다', () => {
    const db = fresh();
    ingest(db, SECTOR);
    const result = ingest(db, PERIOD);
    expect(result).toMatchObject({ inserted: true, parsed: true, rows: { prices: 19 } });
    const rows = pricesAsOf(db, '005930', '99999999');
    expect(rows.at(-1)).toMatchObject({ date: '20240628', close: 81500, value: 768935755446 });
    expect(rows.some((row) => row.close === 269500)).toBe(false);
  });

  it('같은 응답을 다시 받으면 아무것도 하지 않는다', () => {
    const db = fresh();
    ingest(db, SECTOR);
    expect(ingest(db, SECTOR)).toMatchObject({ inserted: false });
    expect(db.prepare('SELECT count(*) AS n FROM raw').get().n).toBe(1);
  });

  it('파서 없는 소스는 raw로만 남긴다', () => {
    const db = fresh();
    const result = ingest(db, {
      source: 'dart.financial-as-filed',
      params: {},
      body: '{}',
      fetchedAt: '2026-09-30T00:00:00Z',
    });
    expect(result).toMatchObject({ inserted: true, parsed: false });
  });

  it('공시는 접수일 다음 거래일부터 알려진다 — 주말·휴장일을 건너뛴다', () => {
    const db = fresh();
    ingest(db, SECTOR);
    ingest(db, DISCLOSURES);
    const calendar = tradingCalendar(db);
    expect(calendar).not.toContain('20240606'); // 현충일
    for (const row of disclosuresAsOf(db, '00126380', '99999999')) {
      expect(row.known_at > row.rcept_dt).toBe(true);
      expect(calendar).toContain(row.known_at);
      expect(calendar.some((day) => day > row.rcept_dt && day < row.known_at)).toBe(false);
    }
    // 06-04 접수 → 06-05, 06-07 접수 → 06-10(주말)
    const known = (dt) =>
      disclosuresAsOf(db, '00126380', '99999999').find((row) => row.rcept_dt === dt).known_at;
    expect(known('20240604')).toBe('20240605');
    expect(known('20240607')).toBe('20240610');
  });

  it('달력 끝날 접수분은 건너뛰고, 달력이 늘어난 뒤 rebuild가 싣는다', () => {
    const db = fresh();
    ingest(db, SECTOR);
    const first = ingest(db, DISCLOSURES);
    const total = JSON.parse(DISCLOSURES.body).result.list.length;
    const lastDay = JSON.parse(DISCLOSURES.body).result.list.filter(
      (row) => row.rcept_dt === '20240628',
    ).length;
    expect(first.skipped).toBe(lastDay);
    expect(first.rows.disclosures).toBe(total - lastDay);

    ingest(db, JULY);
    expect(rebuild(db).skipped).toBe(0);
    const late = disclosuresAsOf(db, '00126380', '20240701').filter(
      (row) => row.rcept_dt === '20240628',
    );
    expect(late).toHaveLength(lastDay);
    expect(late.every((row) => row.known_at === '20240701')).toBe(true);
    expect(disclosuresAsOf(db, '00126380', '20240628').some((r) => r.rcept_dt === '20240628')).toBe(
      false,
    );
  });

  it('rebuild 결과 = 처음 적재 결과, 도착 순서와 무관', () => {
    const inOrder = fresh();
    for (const response of [SECTOR, JULY, PERIOD, DISCLOSURES]) ingest(inOrder, response);
    const before = dump(inOrder);

    rebuild(inOrder);
    expect(dump(inOrder)).toEqual(before);

    const reversed = fresh();
    for (const response of [DISCLOSURES, PERIOD, JULY, SECTOR]) ingest(reversed, response);
    rebuild(reversed);
    expect(dump(reversed)).toEqual(before);
  });

  it('같은 날짜를 다시 받으면 늦게 받은 쪽이 남는다', () => {
    const db = fresh();
    ingest(db, SECTOR);
    const refetch = {
      ...SECTOR,
      params: { ...SECTOR.params, note: 'refetch' },
      body: JSON.stringify({ data: [{ stck_bsop_date: '20240628', bstp_nmix_prpr: '2800.00' }] }),
      fetchedAt: '2026-10-01T00:00:00Z',
    };
    ingest(db, refetch);
    expect(indexAsOf(db, '0001', '20240628').at(-1).close).toBe(2800);
    rebuild(db);
    expect(indexAsOf(db, '0001', '20240628').at(-1).close).toBe(2800);
  });

  it('변환 실패는 raw까지 되돌린다', () => {
    const db = fresh();
    const bad = {
      ...SECTOR,
      body: JSON.stringify({ data: [{ stck_bsop_date: '2024-06-28', bstp_nmix_prpr: '1' }] }),
    };
    expect(() => ingest(db, bad)).toThrow(/YYYYMMDD/);
    expect(db.prepare('SELECT count(*) AS n FROM raw').get().n).toBe(0);
  });
});

// 노드메이슨(01328170) FY2024 연결 영업이익: 원본 흑자 → 정정 적자 (2026-09-30 XBRL 실측)
const CORP = '01328170';
const filing = (rcept_no, known_at, value) => ({
  corp_code: CORP,
  bsns_year: 2024,
  reprt_code: '11011',
  fs_div: 'CFS',
  account_id: 'dart_OperatingIncomeLoss',
  value,
  is_cumulative: 1,
  period_end: '20241231',
  rcept_no,
  known_at,
});
const ORIGINAL = filing('20250318001317', '20250319', 28915427);
const AMENDED = filing('20250828000839', '20250829', -190143795);

function withFinancials(rows) {
  const db = fresh();
  const { sha256 } = ingest(db, {
    source: 'test.fixture',
    params: {},
    body: '{}',
    fetchedAt: '2026-09-30T00:00:00Z',
  });
  loadFacts(db, 'financials', rows, sha256);
  return { db, sha256 };
}

describe('재무 as-of', () => {
  const { db } = withFinancials([AMENDED, ORIGINAL]);
  const operating = (rows) => rows.map((row) => row.value);

  it('정정 전 시점에는 원본, 정정 후에는 정정본', () => {
    expect(operating(financialsAsOf(db, CORP, '20250630'))).toEqual([28915427]);
    expect(operating(financialsAsOf(db, CORP, '20250930'))).toEqual([-190143795]);
  });

  it('접수일 당일은 아직 모른다', () => {
    expect(financialsAsOf(db, CORP, '20250318')).toEqual([]);
    expect(operating(financialsAsOf(db, CORP, '20250319'))).toEqual([28915427]);
    expect(operating(financialsAsOf(db, CORP, '20250828'))).toEqual([28915427]);
  });

  it('latest는 오늘의 JSON API처럼 정정본', () => {
    expect(financialsLatest(db, CORP)).toMatchObject([{ rcept_no: '20250828000839' }]);
  });
});

describe('제약 — 조용한 오류를 적재에서 막는다', () => {
  it('같은 접수본의 같은 계정을 두 번 싣지 못한다', () => {
    const { db, sha256 } = withFinancials([ORIGINAL]);
    expect(() => loadFacts(db, 'financials', [ORIGINAL], sha256)).toThrow(/UNIQUE/);
  });

  it('8자리가 아닌 날짜, 기간 이전의 known_at, 모르는 보고서 코드를 거부한다', () => {
    const { db, sha256 } = withFinancials([]);
    const bad = [
      { ...ORIGINAL, known_at: '2025-03-19' },
      { ...ORIGINAL, known_at: '20241231' },
      { ...ORIGINAL, reprt_code: '99999' },
      { ...ORIGINAL, fs_div: 'XXX' },
    ];
    for (const row of bad) expect(() => loadFacts(db, 'financials', [row], sha256)).toThrow();
    expect(financialsLatest(db, CORP)).toEqual([]);
  });

  it('없는 raw를 가리키는 행은 싣지 않는다', () => {
    const db = fresh();
    expect(() => loadFacts(db, 'financials', [ORIGINAL], 'f'.repeat(64))).toThrow(PitError);
  });
});

/** mulberry32 — a seeded PRNG so a failing case can be replayed. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('미래 누출 속성 테스트', () => {
  const random = prng(20260930);
  const day = (offset) =>
    new Date(Date.UTC(2020, 0, 1) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
  const pick = (n) => Math.floor(random() * n);

  // Random filings: several amendments per period, filed in any order.
  const rows = [];
  for (let i = 0; i < 300; i += 1) {
    const year = 2020 + pick(4);
    const periodEnd = `${year}1231`;
    const filedOffset = (year - 2020) * 365 + 365 + 60 + pick(400);
    rows.push({
      ...ORIGINAL,
      bsns_year: year,
      account_id: `acct_${pick(3)}`,
      value: pick(1_000_000) - 500_000,
      period_end: periodEnd,
      rcept_no: `${day(filedOffset)}${String(i).padStart(6, '0')}`,
      known_at: day(filedOffset + 1),
    });
  }
  const { db } = withFinancials(rows);

  it('임의의 as_of에서 known_at > as_of인 행이 하나도 없고, 두 번 조회해도 같다', () => {
    for (let i = 0; i < 200; i += 1) {
      const asOf = day(pick(365 * 6));
      const bundle = financialsAsOf(db, CORP, asOf);
      expect(bundle.every((row) => row.known_at <= asOf)).toBe(true);
      expect(financialsAsOf(db, CORP, asOf)).toEqual(bundle);
      // each picked row is the newest known filing of its period and account
      for (const row of bundle) {
        const newer = rows.filter(
          (r) =>
            r.bsns_year === row.bsns_year &&
            r.account_id === row.account_id &&
            r.known_at <= asOf &&
            (r.known_at > row.known_at ||
              (r.known_at === row.known_at && r.rcept_no > row.rcept_no)),
        );
        expect(newer).toEqual([]);
      }
    }
  });
});
