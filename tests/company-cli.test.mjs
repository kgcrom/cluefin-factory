import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, main } from '../scripts/company.mjs';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { fakeFilingCli } from './fixtures/filing-cli.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** One real `collect` run for 192820 on 2026-10-12, trimmed to the rows the script reads. */
const F = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/company-192820-20261012.json'), 'utf8'),
);
const flag = (args, name) => args[args.indexOf(name) + 1];

/** Answers like the real CLI; statements by year and report, candles by window. */
function fakeCli(args) {
  const path = args.slice(0, 3).join(' ');
  if (args[1] === 'corp-code-lookup') return { data: [{ corp_code: F.corpCode }] };
  if (args[1] === 'company-overview') return F.overview;
  if (args[1] === 'financial-full-statements') {
    const key = `${flag(args, '--bsns-year')}-${flag(args, '--reprt-code')}`;
    const list = flag(args, '--fs-div') === 'CFS' ? (F.statements[key] ?? null) : null;
    return { result: { status: list ? '000' : '013', list } };
  }
  if (args[1] === 'share-count') return { result: { list: F.shareCount } };
  if (args[1] === 'major-shareholder') return { result: { list: F.majorShareholder } };
  if (args[1] === 'disclosure-search') return { result: F.disclosures };
  if (path === 'kis chart period') {
    const rows = F.candles.filter(
      (c) =>
        c.stck_bsop_date >= flag(args, '--start-date') &&
        c.stck_bsop_date <= flag(args, '--end-date'),
    );
    return { data: rows.slice(-100).reverse() };
  }
  if (path === 'kis sector daily') return { data: F.index };
  if (path === 'kis stock estimated-earnings') return F.estimates;
  if (path === 'kis stock investment-opinion') return { data: F.opinions };
  if (path === 'kis stock current-price') return F.currentPrice;
  if (args[1] === 'document-section' || args[1] === 'financial-notes') return fakeFilingCli(args);
  throw new Error(`fake CLI: ${args.join(' ')}`);
}

// 2026-10-12 16:00 KST, after the close
const AFTER_CLOSE = new Date('2026-10-12T07:00:00Z');
const deps = () => ({ cli: vi.fn(fakeCli), now: AFTER_CLOSE });

describe('company.mjs collect', () => {
  afterEach(() => vi.restoreAllMocks());

  it('사용법 오류는 CLI를 부르지 않고 exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    for (const argv of [
      ['check', '--symbol', '192820'],
      ['collect'],
      ['collect', '--symbol', '19282'],
      ['collect', '--symbol', '192820', '--as-of', '2026-10-12'],
      ['collect', '--symbol', '192820', '--name', '코스맥스'],
    ]) {
      expect(await main(argv, d), argv.join(' ')).toBe(2);
    }
    expect(d.cli).not.toHaveBeenCalled();
  });

  it('192820의 리포트 숫자를 한 번에 낸다(억원)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['collect', '--symbol', '192820', '--as-of', '20261012'], deps())).toBe(0);
    const out = JSON.parse(log.mock.calls[0][0]);
    expect(out).toMatchObject({
      name: '코스맥스',
      market: 'KOSPI',
      statementBasis: 'CFS',
      intraday: false,
      keyData: {
        price: { date: '20261008', close: 303500 },
        week52: { high: 320000, low: 141000 },
        trading: { sessions: 60, value: 321.05 },
        index: { code: '0001', close: 6625.93, change: -2.62 },
        shares: { outstanding: 11345662 },
        holders: { largest: { name: '코스맥스비티아이', ratio: 27.23 } },
        foreignRatio: 34.48,
      },
      valuation: { marketCap: 34434.08, perTtm: 18.69, pbr: 5.33 },
      opinions: { count: 18, max: { target: 410000, broker: '교보' } },
      latest: { period: '2026H1', freeCashFlow: -593.12, debtRatio: 276.14 },
    });

    expect(out.quarters).toHaveLength(8);
    expect(out.quarters.at(-1)).toMatchObject({
      period: '2026Q2',
      revenue: 7948.91,
      opm: 9.28,
      yoy: { revenue: 27.48, operatingIncome: 21.25 },
    });
    // 4Q는 연간 − 9개월 누적
    expect(out.quarters.find((q) => q.period === '2025Q4').revenue).toBe(6010.07);

    const fy2025 = out.annual.at(-1);
    expect(fy2025).toMatchObject({
      year: 2025,
      revenue: 23987.58,
      freeCashFlow: -1002.58,
      debtRatio: 247.1,
      roe: 23.86,
      interestCoverage: 4.19,
    });
    expect(fy2025.borrowingsBasis).toMatch(/^금융부채/);

    const estimate = out.consensus.years.find((y) => y.period === '2026.12E');
    expect(estimate).toMatchObject({ revenue: 29957, netIncomeOwners: 1725, eps: 15207.1 });
    expect(out.disclosures.total).toBe(77);
    // 원문 발췌는 최신 보고서(2026 반기)의 접수번호로 읽는다
    const latestH1 = F.statements['2026-11012'][0].rcept_no;
    expect(out.filing.rceptNo).toBe(latestH1);
    expect(out.filing.notes.selected.map((n) => n.title)).toEqual(['차입금']);
  });

  it('as-of 뒤에 제출된 보고서는 쓰지 않는다', () => {
    const out = collect({ symbol: '192820', 'as-of': '20260801' }, deps());
    expect(out.latest.period).toBe('2026Q1');
    expect(out.quarters.at(-1).period).toBe('2026Q1');
    expect(out.keyData.price.date <= '20260801').toBe(true);
    expect(out.keyData.foreignRatio).toBeNull(); // 오늘이 아니면 현재가 API를 부르지 않는다
  });

  it('원문 발췌가 실패해도 나머지는 그대로 내고 실패를 적는다', () => {
    const cli = vi.fn((args) => {
      if (args[1] === 'document-section')
        throw new CluefinError(4, '{"error":{"retryable":false}}');
      return fakeCli(args);
    });
    const out = collect({ symbol: '192820', 'as-of': '20261012' }, { cli, now: AFTER_CLOSE });
    expect(out.filing).toMatchObject({ error: { exit_code: 4 } });
    expect(out.quarters).toHaveLength(8);
  });
});
