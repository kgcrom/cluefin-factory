import { afterEach, describe, expect, it, vi } from 'vitest';
import { CluefinError } from '../scripts/lib/cluefin.mjs';
import { main, pick, READ_ITEMS } from '../scripts/peer.mjs';

const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const META = {
  cik: 723125,
  name: 'MICRON TECHNOLOGY INC',
  sic_description: 'Semiconductors & Related Devices',
  fiscal_year_end: '0903',
};
// Shapes from `sec filings` on 2026-10-12, newest first.
const PERIODIC = [
  {
    accession_number: '0000723125-26-000023',
    form: '10-K',
    filing_date: '2026-10-09',
    report_date: '2026-09-03',
  },
  {
    accession_number: '0000723125-26-000015',
    form: '10-Q',
    filing_date: '2026-06-25',
    report_date: '2026-05-28',
  },
];
const EARNINGS = [
  {
    accession_number: '0000723125-26-000018',
    form: '8-K',
    filing_date: '2026-09-30',
    report_date: '2026-09-30',
    items: ['2.02', '9.01'],
  },
  {
    accession_number: '0000723125-26-000013',
    form: '8-K',
    filing_date: '2026-06-24',
    report_date: '2026-06-24',
    items: ['2.02', '9.01'],
  },
];
const item = (key, chars) => ({
  key,
  title: key,
  chars,
  uncertain: false,
  warnings: [],
  incorporated_by_reference: false,
  method: 'toc_anchor',
});

function fakeCli(args) {
  if (args[1] === 'company-lookup')
    return { data: flag(args, '--ticker') === 'MU' ? [{ cik: 723125, name: META.name }] : [] };
  if (args[1] === 'filings') {
    const rows = flag(args, '--forms') === '8-K' ? EARNINGS : PERIODIC;
    return { ...META, data: rows };
  }
  if (args[1] === 'filing-items') {
    const tenK = flag(args, '--accession-number') === PERIODIC[0].accession_number;
    return {
      missing: [],
      omitted: tenK ? [] : ['II:3'],
      items: tenK
        ? [item('1A', 118118), item('7', 52000)]
        : [item('I:2', 33796), item('II:1A', 108516)],
    };
  }
  throw new Error(`fake CLI: ${args.join(' ')}`);
}

const NOW = new Date('2026-10-12T07:00:00Z');
const deps = (cli = fakeCli) => ({ cli: vi.fn(cli), now: NOW });

describe('peer.mjs pick', () => {
  afterEach(() => vi.restoreAllMocks());

  it('사용법 오류는 CLI를 부르지 않고 exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps();
    for (const argv of [
      ['collect', '--ticker', 'MU'],
      ['pick'],
      ['pick', '--ticker', 'M U'],
      ['pick', '--ticker', 'MU', '--as-of', '2026-10-12'],
      ['pick', '--ticker', 'MU', '--forms', '10-K'],
    ]) {
      expect(await main(argv, d), argv.join(' ')).toBe(2);
    }
    expect(d.cli).not.toHaveBeenCalled();
  });

  it('최신 10-K와 실적 8-K를 고르고 읽을 명령을 낸다', () => {
    const d = deps();
    const out = pick({ ticker: 'mu' }, d);
    expect(out).toMatchObject({
      ticker: 'MU',
      cik: 723125,
      sic: 'Semiconductors & Related Devices',
      fiscalYearEnd: '0903',
      asOf: '20261012',
      foreignPrivateIssuer: false,
      periodic: { form: '10-K', accessionNumber: '0000723125-26-000023', read: READ_ITEMS['10-K'] },
      earnings: { accessionNumber: '0000723125-26-000018', exhibit: 'EX-99.1' },
    });
    expect(out.periodic.items.map((i) => [i.key, i.chars])).toEqual([
      ['1A', 118118],
      ['7', 52000],
    ]);
    expect(out.next).toEqual([
      'uv run cluefin-openapi-cli sec filing-items --cik 723125 --accession-number 0000723125-26-000023 --items 1A --json',
      'uv run cluefin-openapi-cli sec filing-items --cik 723125 --accession-number 0000723125-26-000023 --items 7 --json',
      'uv run cluefin-openapi-cli sec filing-exhibit --cik 723125 --accession-number 0000723125-26-000018 --exhibit EX-99.1 --json',
    ]);

    const filings = d.cli.mock.calls.map(([args]) => args).filter((args) => args[1] === 'filings');
    expect(filings.map((args) => flag(args, '--include-amendments'))).toEqual(['false', 'false']);
    expect(filings.map((args) => flag(args, '--items'))).toEqual([undefined, '2.02']);
  });

  it('as-of 뒤에 제출된 공시는 고르지 않는다 — 10-Q면 Part 키로 읽는다', () => {
    const out = pick({ ticker: 'MU', 'as-of': '20260801' }, deps());
    expect(out.periodic).toMatchObject({
      form: '10-Q',
      filingDate: '2026-06-25',
      read: ['II:1A', 'I:2'],
      omitted: ['II:3'],
    });
    expect(out.earnings.filingDate).toBe('2026-06-24');
    expect(out.next[0]).toContain('--items II:1A');
  });

  it('20-F/6-K 제출사는 foreignPrivateIssuer, 고를 것이 없다', () => {
    const cli = (args) => {
      if (args[1] === 'company-lookup')
        return { data: [{ cik: 1445930, name: 'KB Financial Group Inc.' }] };
      if (args[1] === 'filings') {
        return {
          name: 'KB Financial Group Inc.',
          data: [],
          hint: 'Forms this company filed recently: 20-F, 6-K.',
        };
      }
      throw new Error(`fake CLI: ${args.join(' ')}`);
    };
    const out = pick({ ticker: 'KB' }, deps(cli));
    expect(out).toMatchObject({
      foreignPrivateIssuer: true,
      periodic: null,
      earnings: null,
      next: [],
    });
  });

  it('없는 티커는 exit 1, CLI 자격증명 오류(SEC_USER_AGENT 없음)는 exit 3을 그대로', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['pick', '--ticker', 'NOPE'], deps())).toBe(1);
    const noAgent = () => {
      throw new CluefinError(3, '{"error":{"type":"CredentialsMissing"}}');
    };
    expect(await main(['pick', '--ticker', 'MU'], deps(noAgent))).toBe(3);
  });
});
