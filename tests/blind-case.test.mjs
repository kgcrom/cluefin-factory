import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  brokerAlias,
  buildCase,
  CaseError,
  canonicalJson,
  caseIdFrom,
  relativeDay,
  sealHash,
  technicalBlock,
} from '../scripts/blind/case.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const series = read('tests/fixtures/series-383220.json');
const technical = read('tests/fixtures/technical-005930-20240628.json');
const validateCase = new Ajv({ strict: false }).compile(read('schemas/blind-case.schema.json'));

// The 383220 fixture has close/high/low only; open and volume are synthetic.
const prices = series.prices.map((row, i) => ({
  ...row,
  open: row.close,
  volume: 1_000_000 + i * 10_000,
}));
const AS_OF = prices[69].date; // 70 rows up to as_of
const REFERENCE = prices[69].close;
const index = series.index.filter((row) => row.date <= AS_OF);

const META = {
  caseId: 'abcdefghijkl',
  symbol: '383220',
  names: ['에프앤에프', 'F&F'],
  market: 'KOSPI',
  asOf: AS_OF,
  horizonDays: 20,
  benchmarkCode: '2001',
};

const build = (inputs = {}, meta = {}) =>
  buildCase({ ...META, ...meta }, { prices: prices.slice(0, 70), index, ...inputs });

describe('relativeDay', () => {
  const dates = ['20240624', '20240625', '20240628'];
  it('as_of는 0, 이전 거래일은 음수', () => {
    expect(relativeDay(dates, '20240628')).toBe(0);
    expect(relativeDay(dates, '20240624')).toBe(-2);
  });
  it('휴장일은 다음 거래일로 민다', () => {
    expect(relativeDay(dates, '20240626')).toBe(0);
  });
  it('창 이전 날짜는 null', () => {
    expect(relativeDay(dates, '20240621')).toBeNull();
  });
});

describe('buildCase', () => {
  it('가격·벤치마크만으로 스키마에 맞는 케이스를 만든다', () => {
    const { case: blind, seal } = build();
    expect(validateCase(blind), JSON.stringify(validateCase.errors)).toBe(true);
    expect(blind.prices).toHaveLength(70);
    expect(blind.prices.at(-1)).toMatchObject({ d: 0, close: 100 });
    expect(blind.prices[0].d).toBe(-69);
    expect(blind.benchmark.name).toBe('KOSPI200');
    expect(blind.benchmark.series.at(-1)).toEqual({ d: 0, close: 100 });
    expect(blind.technical).toBeNull();
    expect(seal).toMatchObject({
      symbol: '383220',
      name: '에프앤에프',
      as_of: AS_OF,
      reference_price: REFERENCE,
      horizon_days: 20,
    });
    expect(seal.case_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('창은 최근 120거래일로 자른다', () => {
    const long = Array.from({ length: 150 }, (_, i) => ({
      date: String(20200101 + i),
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 5,
    }));
    const asOf = long.at(-1).date;
    const { case: blind } = buildCase(
      { ...META, asOf },
      { prices: long, index: [{ date: asOf, close: 1 }] },
    );
    expect(blind.prices).toHaveLength(120);
    expect(blind.prices[0].d).toBe(-119);
  });

  it('거래량은 최근 20일 평균 대비 배수다', () => {
    const { case: blind } = build();
    const recent = prices.slice(50, 70);
    const base = recent.reduce((sum, row) => sum + row.volume, 0) / 20;
    expect(blind.prices.at(-1).volume_x).toBe(Math.round((prices[69].volume / base) * 100) / 100);
  });

  it('같은 입력이면 같은 케이스·같은 봉인 해시', () => {
    expect(canonicalJson(build())).toBe(canonicalJson(build()));
    expect(sealHash(build().seal)).toBe(sealHash(build().seal));
  });

  it('as_of 이후 행이 들어오면 거부한다', () => {
    expect(() => build({ prices: prices.slice(0, 71) })).toThrow(CaseError);
    expect(() => build({ disclosures: [{ known_at: prices[70].date, title: '공시' }] })).toThrow(
      /미래 누출/,
    );
    expect(() =>
      build({
        opinions: [{ known_at: '20991231', broker: 'X', opinion: 'BUY', target_price: 1 }],
      }),
    ).toThrow(/미래 누출/);
  });

  it('가격이 60행보다 짧으면 거부한다', () => {
    expect(() =>
      buildCase({ ...META, asOf: prices[40].date }, { prices: prices.slice(0, 41), index }),
    ).toThrow(/최소 60행/);
  });

  it('horizon·market·case_id 형식을 검사한다', () => {
    expect(() => build({}, { horizonDays: 40 })).toThrow(/20\/60\/120/);
    expect(() => build({}, { market: 'NASDAQ' })).toThrow(CaseError);
    expect(() => build({}, { caseId: 'a1b2c3d4e5f6' })).toThrow(/case_id/);
  });

  it('공시 제목에서 회사명·연도를 지우고 상대 거래일을 붙인다', () => {
    const { case: blind } = build({
      disclosures: [
        { known_at: AS_OF, title: '에프앤에프 분기보고서 (2026.06)' },
        { known_at: prices[60].date, title: 'F&F 주요사항보고서(자기주식취득결정)' },
        { known_at: '20200101', title: '창 밖 공시' },
      ],
    });
    expect(blind.disclosures).toEqual([
      { d: -9, title: '[회사] 주요사항보고서(자기주식취득결정)' },
      { d: 0, title: '[회사] 분기보고서 ([연도].06)' },
    ]);
  });

  it('마스킹이 못 지운 식별자가 남으면 케이스를 만들지 않는다', () => {
    expect(() =>
      build({ opinions: [{ known_at: AS_OF, broker: 'X', opinion: '383220 매수' }] }),
    ).toThrow(/식별자가 남았다/);
  });

  it('의견: 증권사는 첫 등장 순 알파벳, 목표가는 그날 종가 대비 %', () => {
    const { case: blind } = build({
      opinions: [
        { known_at: AS_OF, broker: '키움', opinion: 'BUY', prev_opinion: 'BUY', target_price: 0 },
        { known_at: prices[65].date, broker: '미래', opinion: 'BUY', target_price: 100000 },
        { known_at: prices[60].date, broker: '키움', opinion: 'HOLD', target_price: 90000 },
      ],
    });
    expect(blind.opinions.map((row) => [row.d, row.broker])).toEqual([
      [-9, 'A'],
      [-4, 'B'],
      [0, 'A'],
    ]);
    const upside = Math.round((100000 / prices[65].close - 1) * 10000) / 100;
    expect(blind.opinions[1].target_upside_pct).toBe(upside);
    expect(blind.opinions[2].target_upside_pct).toBeNull();
  });

  it('의견: 증권사가 26곳을 넘으면 AA부터 두 글자로 잇는다', () => {
    expect([0, 25, 26, 27, 51, 52].map(brokerAlias)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
    const opinions = Array.from({ length: 30 }, (_, i) => ({
      known_at: AS_OF,
      broker: `증권${String.fromCharCode(0xac00 + i)}`,
      opinion: 'BUY',
    }));
    const { case: blind } = build({ opinions });
    expect(blind.opinions.at(-1).broker).toBe('AD');
    expect(validateCase(blind)).toBe(true);
  });

  it('거래량이 숫자가 아니면 조용히 null로 두지 않고 멈춘다', () => {
    const broken = prices.slice(0, 70).map((row, i) => (i === 65 ? { ...row, volume: null } : row));
    expect(() => buildCase(META, { prices: broken, index })).toThrow(/volume/);
  });

  it('수급은 그날 거래량 대비 %', () => {
    const day = prices[69];
    const { case: blind } = build({
      flows: [
        { date: day.date, foreign_net_qty: day.volume / 10, institution_net_qty: -day.volume / 4 },
      ],
    });
    expect(blind.flows).toEqual([
      { d: 0, foreign_net_pct: 10, institution_net_pct: -25, short_pct: null },
    ]);
  });

  it('재무: 회계연도는 years_back으로, 모르는 지표는 거부한다', () => {
    const { case: blind } = build({
      financials: [
        { known_at: prices[30].date, bsns_year: '2025', period: 'FY', metrics: { roe: 12.3 } },
        { known_at: prices[60].date, bsns_year: '2026', period: 'Q1', metrics: { roe: 3.1 } },
      ],
    });
    expect(blind.financials).toEqual([
      { known_d: -9, years_back: 0, period: 'Q1', metrics: { roe: 3.1 } },
      { known_d: -39, years_back: 1, period: 'FY', metrics: { roe: 12.3 } },
    ]);
    expect(() =>
      build({
        financials: [{ known_at: AS_OF, bsns_year: '2026', period: 'Q1', metrics: { eps: 1 } }],
      }),
    ).toThrow(/지표 eps/);
  });
});

describe('technicalBlock', () => {
  const reference = 81500;
  const rebase = (value) => Math.round((value / reference) * 10000) / 100;
  const block = technicalBlock(technical, '20240628', reference, rebase);

  it('가격형 지표는 재기준화, 비율형은 그대로', () => {
    expect(block.indicators.sma_20).toBe(rebase(78565));
    expect(block.indicators.atr_14).toBe(rebase(1721.73));
    expect(block.indicators.macd.histogram).toBe(rebase(381.9633));
    expect(block.indicators.bbands_20.percent_b).toBe(0.7915);
    expect(block.indicators.rsi_14).toBe(59.95);
  });

  it('obv와 원 가격을 인용하는 reason 문자열을 버린다', () => {
    expect(block.indicators.obv).toBeUndefined();
    expect(block.signal.rules[0]).toEqual({ name: 'macd', family: 'trend', vote: 1 });
    expect(JSON.stringify(block)).not.toMatch(/81500|381\.96|reason/);
  });

  it('as_of나 종가가 가격 블록과 다르면 거부한다', () => {
    expect(() => technicalBlock(technical, '20240627', reference, rebase)).toThrow(/as_of/);
    expect(() => technicalBlock(technical, '20240628', 80000, rebase)).toThrow(/종가/);
    const { close: _close, ...noClose } = technical;
    expect(() => technicalBlock(noClose, '20240628', reference, rebase)).toThrow(/close/);
  });
});

describe('caseIdFrom', () => {
  it('소문자 12자', () => {
    let seed = 0;
    const id = caseIdFrom(() => {
      seed = (seed + 0.37) % 1;
      return seed;
    });
    expect(id).toMatch(/^[a-z]{12}$/);
  });
});
