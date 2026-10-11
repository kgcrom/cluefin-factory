import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { buildListing, resolveStock } from '../scripts/watchlist/resolve.mjs';
import { check, kstClock, main } from '../scripts/watchlist.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const load = (name) =>
  JSON.parse(readFileSync(join(ROOT, `tests/fixtures/${name}-20261006.json`), 'utf8'));
const flag = (args, name) => args[args.indexOf(name) + 1];

const SUMMARY = {
  0: [
    { code: '033780', name: 'KT&G', upName: '음식료/담배', upSizeName: '대형주', kind: 'A' },
    { code: '033785', name: 'KT&G우', upName: '음식료/담배', upSizeName: '', kind: 'A' },
    { code: '089860', name: '롯데렌탈', upName: '일반서비스', upSizeName: '중형주', kind: 'A' },
  ],
  10: [
    { code: '092870', name: '엑시콘', upName: '반도체', kind: 'A', companyClassName: '' },
    { code: '068790', name: 'DMS', upName: '기계/장비', kind: 'A', companyClassName: '' },
  ],
};
const INDEX = { '0001': load('watchlist-index-0001'), 1001: load('watchlist-index-1001') };

/** Answers like the real CLI: the newest 100 rows of the window, newest first. */
function fakeCli(args) {
  const path = args.slice(0, 3).join(' ');
  if (path === 'kiwoom stock summary') return { list: SUMMARY[flag(args, '--market-type')] };
  if (path === 'kis chart period') {
    const { candles } = load(`watchlist-${flag(args, '--stock-code')}`);
    const rows = candles
      .filter((c) => c.date >= flag(args, '--start-date') && c.date <= flag(args, '--end-date'))
      .slice(-100)
      .reverse();
    return {
      data: rows.map((c) => ({
        stck_bsop_date: c.date,
        stck_oprc: String(c.open),
        stck_hgpr: String(c.high),
        stck_lwpr: String(c.low),
        stck_clpr: String(c.close),
        acml_vol: String(c.volume),
        acml_tr_pbmn: String(c.value),
      })),
    };
  }
  if (path === 'kis sector daily') {
    const rows = INDEX[flag(args, '--sector-code')].closes
      .filter((r) => r.date <= flag(args, '--start-date'))
      .slice(-100)
      .reverse();
    return { data: rows.map((r) => ({ stck_bsop_date: r.date, bstp_nmix_prpr: String(r.close) })) };
  }
  throw new Error(`fake CLI: ${args.join(' ')}`);
}

// 장 마감 뒤(16:00 KST)와 장중(10:00 KST)
const AFTER_CLOSE = new Date('2026-10-06T07:00:00Z');
const MARKET_HOURS = new Date('2026-10-06T01:00:00Z');
const deps = (overrides = {}) => ({
  cli: vi.fn(fakeCli),
  now: AFTER_CLOSE,
  cacheDir: mkdtempSync(join(tmpdir(), 'watchlist-')),
  ...overrides,
});

describe('watchlist.mjs check', () => {
  afterEach(() => vi.restoreAllMocks());

  it('사용법 오류는 CLI를 부르지 않고 exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    for (const argv of [
      ['list'],
      ['check'],
      ['check', '--symbol'],
      ['check', '--symbol', '33780'],
      ['check', '--symbol', '033780', '--name', 'KT&G'],
      ['check', '--symbol', '033780', '--as-of', '2026-10-06'],
      ['check', '--symbol', '033780', '--se-rs', '69'],
    ]) {
      expect(await main(argv, d), argv.join(' ')).toBe(2);
    }
    expect(d.cli).not.toHaveBeenCalled();
  });

  it('종목명으로 찾아 코스피 지수(0001)와 비교하고 JSON을 낸다', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['check', '--name', 'kt&g', '--as-of', '20261006'], deps())).toBe(0);
    const out = JSON.parse(log.mock.calls[0][0]);
    expect(out).toMatchObject({
      symbol: '033780',
      market: 'KOSPI',
      benchmark: '0001',
      asOf: '20261006',
      action: 'exclude',
      status: 'no_group',
      groups: { g1: false, g2: false, g3: false },
      strength: { rel: 0.81 },
      orders: { buyStop: 179700, alert: 174300 },
    });
    expect(out.checks.g3.find((c) => !c.pass).rule).toBe('지수 대비 1 초과 1.32 미만');
  });

  it('롯데렌탈은 알림, 엑시콘은 코스닥(1001) 기준 1그룹 과열', () => {
    const lotte = check({ symbol: '089860', 'as-of': '20261006' }, deps());
    expect(lotte.action).toBe('alert');
    expect(lotte.orders).toMatchObject({ buyStop: 51000, alert: 49450, stopLoss: 46900 });
    const exicon = check({ name: '엑시콘', 'as-of': '20261006' }, deps());
    expect(exicon.benchmark).toBe('1001');
    expect(exicon.status).toBe('overheated');
  });

  it('장중에는 오늘 봉을 빼고 전일 마감으로 판정한다', () => {
    expect(check({ symbol: '033780' }, deps({ now: MARKET_HOURS })).asOf).toBe('20261002');
    expect(check({ symbol: '033780' }, deps()).asOf).toBe('20261006');
  });

  it('종목 목록은 하루 한 번만 받는다', () => {
    const d = deps();
    check({ symbol: '033780', 'as-of': '20261006' }, d);
    check({ symbol: '089860', 'as-of': '20261006' }, d);
    const summaries = d.cli.mock.calls.filter(([args]) => args[0] === 'kiwoom');
    expect(summaries).toHaveLength(2); // 코스피·코스닥 각 한 번
  });

  it('CLI 오류는 그 종료 코드로 JSON 오류를 낸다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = vi.fn(() => {
      throw new CluefinError(3, '{"error":"credentials"}');
    });
    expect(await main(['check', '--symbol', '033780'], deps({ cli }))).toBe(3);
    expect(JSON.parse(err.mock.calls[0][0]).error.exit_code).toBe(3);
  });

  it('일봉이 모자라면 판정하지 않고 제외', () => {
    const got = check({ symbol: '033780', 'as-of': '20250901' }, deps());
    expect(got.status).toBe('insufficient_history');
    expect(got.action).toBe('exclude');
  });
});

describe('resolve', () => {
  const listing = buildListing({ KOSPI: SUMMARY[0], KOSDAQ: SUMMARY[10] });

  it('우선주는 목록에 없다', () => {
    expect(listing.map((r) => r.symbol)).toEqual(['033780', '089860', '092870', '068790']);
    expect(() => resolveStock(listing, { symbol: '033785' })).toThrow('우선주');
  });

  it('이름은 정확히 → 공백·대소문자 무시 → 유일한 부분 일치 순서로 찾는다', () => {
    expect(resolveStock(listing, { name: 'KT&G' }).symbol).toBe('033780');
    expect(resolveStock(listing, { name: 'dms' }).symbol).toBe('068790');
    expect(resolveStock(listing, { name: '렌탈' }).symbol).toBe('089860');
  });

  it('여러 종목이 맞거나 없으면 추측하지 않고 오류', () => {
    const twins = [...listing, { symbol: '999990', name: '롯데렌탈홀딩스', market: 'KOSPI' }];
    expect(() => resolveStock(twins, { name: '렌탈' })).toThrow('여러 종목');
    expect(() => resolveStock(listing, { name: '없는회사' })).toThrow('없다');
  });
});

describe('kstClock', () => {
  it('UTC를 한국 시간 날짜·분으로 바꾼다', () => {
    expect(kstClock(new Date('2026-10-06T06:39:00Z'))).toEqual({ date: '20261006', minutes: 939 });
    expect(kstClock(new Date('2026-10-06T15:30:00Z')).date).toBe('20261007');
  });
});
