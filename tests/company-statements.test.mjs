import { describe, expect, it } from 'vitest';
import {
  annual,
  borrowings,
  growth,
  latest,
  quarters,
  trailing,
  won,
} from '../scripts/company/statements.mjs';

const revenue = (amounts) => ({ sj_div: 'CIS', account_id: 'ifrs-full_Revenue', ...amounts });
const report = (year, reprtCode, rows) => ({ year, reprtCode, rows });

/** 2025's four reports, each also carrying 2024 in its comparative columns. */
const YEAR_2025 = [
  report(2025, '11013', [
    revenue({
      thstrm_amount: '100',
      thstrm_add_amount: '100',
      frmtrm_q_amount: '80',
      frmtrm_add_amount: '80',
    }),
  ]),
  report(2025, '11012', [
    revenue({ thstrm_amount: '120', thstrm_add_amount: '220', frmtrm_add_amount: '170' }),
  ]),
  report(2025, '11014', [
    revenue({ thstrm_amount: '110', thstrm_add_amount: '330', frmtrm_add_amount: '250' }),
  ]),
  report(2025, '11011', [
    revenue({ thstrm_amount: '460', frmtrm_amount: '350', bfefrmtrm_amount: '300' }),
  ]),
];

describe('won', () => {
  it('쉼표를 지우고, 빈 값·"-"는 null', () => {
    expect(won('1,234,567')).toBe(1234567);
    expect(won('-5')).toBe(-5);
    expect(won('')).toBeNull();
    expect(won('-')).toBeNull();
    expect(won(null)).toBeNull();
  });
});

describe('growth', () => {
  it('양쪽이 흑자일 때만 숫자, 부호가 바뀌면 흑전·적전·적지', () => {
    expect(growth(130, 100)).toBeCloseTo(30);
    expect(growth(10, -5)).toBe('흑전');
    expect(growth(-10, 5)).toBe('적전');
    expect(growth(-10, -5)).toBe('적지');
    expect(growth(10, null)).toBeNull();
  });
});

describe('quarters', () => {
  it('Q2~Q4는 누적끼리 빼고, 4Q는 연간에서 9개월 누적을 뺀다', () => {
    const list = quarters(YEAR_2025);
    const byPeriod = Object.fromEntries(list.map((q) => [q.period, q.revenue]));
    expect(byPeriod).toEqual({
      '2024Q1': 80,
      '2024Q2': 90,
      '2024Q3': 80,
      '2024Q4': 100,
      '2025Q1': 100,
      '2025Q2': 120,
      '2025Q3': 110,
      '2025Q4': 130,
    });
    expect(list.at(-1).yoy.revenue).toBeCloseTo(30);
    expect(list[0].yoy).toBeNull();
  });

  it('그 해 자기 보고서 값이 다음 해 보고서의 전기 비교 열보다 우선한다', () => {
    const own2024 = report(2024, '11011', [revenue({ thstrm_amount: '360' })]);
    const q4 = quarters([...YEAR_2025, own2024]).find((q) => q.period === '2024Q4');
    expect(q4.revenue).toBe(110); // 360 − 250, not 350 − 250
  });

  it('직전 누적이 없으면 그 분기는 비운다', () => {
    const onlyFy = [report(2025, '11011', [revenue({ thstrm_amount: '460' })])];
    expect(quarters(onlyFy)).toEqual([]);
  });
});

describe('borrowings', () => {
  const bs = (account_nm, thstrm_amount, account_id = '-표준계정코드 미사용-') => ({
    sj_div: 'BS',
    account_nm,
    account_id,
    thstrm_amount,
  });

  it('차입금·사채 계정을 이름으로 더한다', () => {
    const rows = [
      bs('단기차입금', '100'),
      bs('사채', '50'),
      bs('장기 차입금', '30'),
      bs('리스부채', '9'),
    ];
    expect(borrowings(rows, 'thstrm_amount')).toEqual({
      amount: 180,
      basis: '차입금·사채 (단기차입금+사채+장기차입금)',
    });
  });

  it('차입금 계정이 없으면 금융부채로 대신하고 그렇다고 적는다', () => {
    const rows = [
      bs('단기금융부채', '70', 'ifrs-full_CurrentFinancialLiabilities'),
      bs('장기금융부채', '20', 'ifrs-full_NoncurrentFinancialLiabilities'),
    ];
    const debt = borrowings(rows, 'thstrm_amount');
    expect(debt.amount).toBe(90);
    expect(debt.basis).toMatch(/^금융부채/);
  });
});

describe('annual', () => {
  const row = (sj_div, account_id, values) => ({
    sj_div,
    account_id,
    thstrm_amount: values[2],
    frmtrm_amount: values[1],
    bfefrmtrm_amount: values[0],
  });
  const rows = [
    row('CIS', 'ifrs-full_Revenue', ['1000', '1000', '1000']),
    row('CIS', 'dart_OperatingIncomeLoss', ['100', '100', '100']),
    row('CIS', 'ifrs-full_ProfitLossAttributableToOwnersOfParent', ['50', '50', '60']),
    row('BS', 'ifrs-full_Liabilities', ['300', '300', '300']),
    row('BS', 'ifrs-full_Equity', ['100', '100', '150']),
    row('BS', 'ifrs-full_EquityAttributableToOwnersOfParent', ['100', '100', '140']),
    row('CF', 'ifrs-full_CashFlowsFromUsedInOperatingActivities', ['80', '80', '80']),
    row('CF', 'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', [
      '30',
      '30',
      '120',
    ]),
  ];

  it('세 해를 오래된 순으로 내고, ROE는 평균 자본으로 나눈다', () => {
    const [y1, , y3] = annual(report(2025, '11011', rows));
    expect(y1.year).toBe(2023);
    expect(y1.roe).toBeNull();
    expect(y3.roe).toBeCloseTo(50); // 60 / ((100 + 140) / 2)
    expect(y3.debtRatio).toBeCloseTo(200);
    expect(y3.freeCashFlow).toBe(-40);
    expect(y3.opm).toBeCloseTo(10);
  });
});

describe('latest', () => {
  it('분기 보고서는 손익을 누적으로, 현금흐름은 thstrm(누적) 그대로 읽는다', () => {
    const rows = [
      revenue({ thstrm_amount: '120', thstrm_add_amount: '220' }),
      {
        sj_div: 'CF',
        account_id: 'ifrs-full_CashFlowsFromUsedInOperatingActivities',
        thstrm_amount: '40',
      },
    ];
    const figures = latest(report(2026, '11012', rows));
    expect(figures.period).toBe('2026H1');
    expect(figures.revenue).toBe(220);
    expect(figures.operatingCashFlow).toBe(40);
    expect(figures).not.toHaveProperty('roe');
  });
});

describe('trailing', () => {
  it('최근 4개 분기가 다 있어야 더한다', () => {
    const q = (v) => ({ netIncomeOwners: v });
    expect(trailing([q(1), q(2), q(3), q(4), q(5)], 'netIncomeOwners')).toBe(14);
    expect(trailing([q(1), q(null), q(3), q(4)], 'netIncomeOwners')).toBeNull();
    expect(trailing([q(1), q(2)], 'netIncomeOwners')).toBeNull();
  });
});
