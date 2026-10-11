/**
 * Quarterly, annual and latest-period figures out of `dart financial-full-statements`.
 *
 * One report carries three periods: an annual report fills `thstrm`/`frmtrm`/`bfefrmtrm`
 * (this year and the two before); a quarterly report fills the quarter in `thstrm_amount`,
 * the year-to-date sum in `thstrm_add_amount`, and the same two for the prior year in
 * `frmtrm_q_amount`/`frmtrm_add_amount`. Quarters are never filed on their own past Q1,
 * so Q2–Q4 are year-to-date differences — the 4Q is the annual minus the 9-month sum.
 *
 * Cash-flow rows in a quarterly report are year-to-date in `thstrm_amount`.
 */

export const QUARTER_OF = { 11013: 1, 11012: 2, 11014: 3, 11011: 4 };
const PERIOD_LABEL = { 1: 'Q1', 2: 'H1', 3: '9M', 4: 'FY' };

const INCOME = new Set(['IS', 'CIS']);
const BALANCE = new Set(['BS']);
const CASH = new Set(['CF']);

/** Income-statement items that are summed per quarter. */
export const INCOME_ITEMS = {
  revenue: { ids: ['ifrs-full_Revenue'], names: ['수익(매출액)', '매출액', '영업수익', '매출'] },
  costOfSales: { ids: ['ifrs-full_CostOfSales'], names: ['매출원가', '영업비용'] },
  grossProfit: { ids: ['ifrs-full_GrossProfit'], names: ['매출총이익'] },
  sga: { ids: ['dart_TotalSellingGeneralAdministrativeExpenses'], names: ['판매비와관리비'] },
  operatingIncome: { ids: ['dart_OperatingIncomeLoss'], names: ['영업이익', '영업이익(손실)'] },
  pretaxIncome: { ids: ['ifrs-full_ProfitLossBeforeTax'], names: ['법인세비용차감전순이익'] },
  netIncome: { ids: ['ifrs-full_ProfitLoss'], names: ['당기순이익', '당기순이익(손실)'] },
  // Owners' share only by id: the same Korean label also names the comprehensive-income split.
  netIncomeOwners: { ids: ['ifrs-full_ProfitLossAttributableToOwnersOfParent'], names: [] },
};

const BALANCE_ITEMS = {
  assets: { ids: ['ifrs-full_Assets'], names: ['자산총계'] },
  currentAssets: { ids: ['ifrs-full_CurrentAssets'], names: ['유동자산'] },
  cash: { ids: ['ifrs-full_CashAndCashEquivalents'], names: ['현금및현금성자산'] },
  receivables: {
    ids: ['ifrs-full_CurrentTradeReceivables', 'ifrs-full_TradeAndOtherCurrentReceivables'],
    names: ['매출채권', '매출채권및기타채권'],
  },
  inventories: { ids: ['ifrs-full_Inventories'], names: ['재고자산'] },
  noncurrentAssets: { ids: ['ifrs-full_NoncurrentAssets'], names: ['비유동자산'] },
  currentLiabilities: { ids: ['ifrs-full_CurrentLiabilities'], names: ['유동부채'] },
  noncurrentLiabilities: { ids: ['ifrs-full_NoncurrentLiabilities'], names: ['비유동부채'] },
  liabilities: { ids: ['ifrs-full_Liabilities'], names: ['부채총계'] },
  equity: { ids: ['ifrs-full_Equity'], names: ['자본총계'] },
  equityOwners: {
    ids: ['ifrs-full_EquityAttributableToOwnersOfParent'],
    names: ['지배기업의소유주에게귀속되는지분', '지배기업소유주지분'],
  },
};

const CASH_ITEMS = {
  operatingCashFlow: {
    ids: ['ifrs-full_CashFlowsFromUsedInOperatingActivities'],
    names: ['영업활동현금흐름'],
  },
  investingCashFlow: {
    ids: ['ifrs-full_CashFlowsFromUsedInInvestingActivities'],
    names: ['투자활동현금흐름'],
  },
  financingCashFlow: {
    ids: ['ifrs-full_CashFlowsFromUsedInFinancingActivities'],
    names: ['재무활동현금흐름'],
  },
  capex: {
    ids: ['ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
    names: ['유형자산의취득'],
  },
  dividendsPaid: {
    ids: ['ifrs-full_DividendsPaidClassifiedAsFinancingActivities'],
    names: ['배당금의지급', '배당금지급'],
  },
  interestExpense: { ids: ['dart_AdjustmentsForInterestExpenses'], names: ['이자비용'] },
};

/** "1,234" / "-5" / "" → number or null. */
export function won(text) {
  if (text === null || text === undefined) return null;
  const clean = String(text).replaceAll(',', '').trim();
  if (clean === '' || clean === '-') return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

const squash = (text) => String(text ?? '').replaceAll(/\s/g, '');

/** The row for one item: XBRL id first, then the Korean label for filers off the taxonomy. */
export function findRow(rows, sections, { ids, names }) {
  const inSection = rows.filter((row) => sections.has(row.sj_div));
  return (
    inSection.find((row) => ids.includes(row.account_id)) ??
    inSection.find((row) => names.some((name) => squash(row.account_nm) === squash(name))) ??
    null
  );
}

/**
 * Borrowings have no single XBRL id: 005930 files 단기차입금 off-taxonomy, 000660 files
 * 차입금 twice, 192820 lumps everything into 단기/장기금융부채. Sum the borrowing lines
 * by label; when a filer has none, fall back to financial liabilities and say so.
 */
const BORROWING = /^(단기|장기|유동성장기|유동성)?(차입금|사채|차입부채|장기부채)$/;

export function borrowings(rows, column) {
  const balance = rows.filter((row) => row.sj_div === 'BS');
  const lines = balance.filter(
    (row) => BORROWING.test(squash(row.account_nm)) && won(row[column]) !== null,
  );
  if (lines.length > 0) {
    return {
      amount: lines.reduce((sum, row) => sum + won(row[column]), 0),
      basis: `차입금·사채 (${lines.map((row) => squash(row.account_nm)).join('+')})`,
    };
  }
  const financial = [
    'ifrs-full_CurrentFinancialLiabilities',
    'ifrs-full_NoncurrentFinancialLiabilities',
  ]
    .map((id) => balance.find((row) => row.account_id === id))
    .filter((row) => row && won(row[column]) !== null);
  if (financial.length === 0) return { amount: null, basis: null };
  return {
    amount: financial.reduce((sum, row) => sum + won(row[column]), 0),
    basis: '금융부채(단기+장기) — 차입금 계정이 따로 없어 리스·기타 금융부채가 섞일 수 있다',
  };
}

function pick(rows, sections, items, column) {
  return Object.fromEntries(
    Object.entries(items).map(([key, item]) => [key, won(findRow(rows, sections, item)?.[column])]),
  );
}

const ratio = (num, den) => (num === null || den === null || den === 0 ? null : num / den);
const pct = (num, den) => {
  const r = ratio(num, den);
  return r === null ? null : r * 100;
};

/**
 * Year-to-date sums per year and quarter, for every income item. A year's own report
 * wins over the comparative column of next year's report (reports are walked oldest
 * first and a slot is filled only once).
 */
export function yearToDate(reports) {
  const ytd = {};
  const put = (year, quarter, key, value) => {
    ytd[year] ??= { 1: {}, 2: {}, 3: {}, 4: {} };
    if (value !== null && ytd[year][quarter][key] === undefined) ytd[year][quarter][key] = value;
  };
  const ordered = [...reports].sort(
    (a, b) => a.year - b.year || QUARTER_OF[a.reprtCode] - QUARTER_OF[b.reprtCode],
  );
  for (const { year, reprtCode, rows } of ordered) {
    const quarter = QUARTER_OF[reprtCode];
    for (const [key, item] of Object.entries(INCOME_ITEMS)) {
      const row = findRow(rows, INCOME, item);
      if (!row) continue;
      if (quarter === 4) {
        put(year, 4, key, won(row.thstrm_amount));
        put(year - 1, 4, key, won(row.frmtrm_amount));
        put(year - 2, 4, key, won(row.bfefrmtrm_amount));
      } else {
        put(year, quarter, key, won(row.thstrm_add_amount) ?? won(row.thstrm_amount));
        put(year - 1, quarter, key, won(row.frmtrm_add_amount) ?? won(row.frmtrm_q_amount));
      }
    }
  }
  return ytd;
}

/** Signed change: a number when both sides are positive, otherwise 흑전/적전/적지. */
export function growth(current, previous) {
  if (current === null || previous === null) return null;
  if (previous > 0 && current > 0) return (current / previous - 1) * 100;
  if (previous <= 0 && current > 0) return '흑전';
  if (previous > 0 && current <= 0) return '적전';
  return '적지';
}

/** Single quarters, oldest first, with YoY against the same quarter a year earlier. */
export function quarters(reports) {
  const ytd = yearToDate(reports);
  const keys = Object.keys(INCOME_ITEMS);
  const single = {};
  for (const year of Object.keys(ytd).map(Number)) {
    for (const quarter of [1, 2, 3, 4]) {
      const now = ytd[year][quarter];
      const before = quarter === 1 ? null : ytd[year][quarter - 1];
      const values = Object.fromEntries(
        keys.map((key) => {
          if (now[key] === undefined) return [key, null];
          if (quarter === 1) return [key, now[key]];
          return [key, before[key] === undefined ? null : now[key] - before[key]];
        }),
      );
      if (values.revenue !== null) single[`${year}Q${quarter}`] = { year, quarter, ...values };
    }
  }
  return Object.entries(single)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, q]) => {
      const prior = single[`${q.year - 1}Q${q.quarter}`];
      return {
        period,
        ...Object.fromEntries(keys.map((key) => [key, q[key]])),
        gpm: pct(q.grossProfit, q.revenue),
        opm: pct(q.operatingIncome, q.revenue),
        yoy: prior
          ? {
              revenue: growth(q.revenue, prior.revenue),
              operatingIncome: growth(q.operatingIncome, prior.operatingIncome),
              netIncomeOwners: growth(q.netIncomeOwners, prior.netIncomeOwners),
            }
          : null,
      };
    });
}

function withRatios(figures, previous) {
  const avg = (key) =>
    previous && figures[key] !== null && previous[key] !== null
      ? (figures[key] + previous[key]) / 2
      : null;
  const netDebt =
    figures.borrowings === null || figures.cash === null ? null : figures.borrowings - figures.cash;
  const fcf =
    figures.operatingCashFlow === null || figures.capex === null
      ? null
      : figures.operatingCashFlow - figures.capex;
  return {
    ...figures,
    netDebt,
    freeCashFlow: fcf,
    gpm: pct(figures.grossProfit, figures.revenue),
    opm: pct(figures.operatingIncome, figures.revenue),
    debtRatio: pct(figures.liabilities, figures.equity),
    netDebtRatio: pct(netDebt, figures.equity),
    interestCoverage: ratio(figures.operatingIncome, figures.interestExpense),
    roe: pct(figures.netIncomeOwners, avg('equityOwners')),
    roa: pct(figures.netIncome, avg('assets')),
  };
}

const COLUMNS = ['bfefrmtrm_amount', 'frmtrm_amount', 'thstrm_amount'];

/** Three fiscal years out of one annual report, oldest first. ROE/ROA need the year before, so the oldest has none. */
export function annual(report) {
  const years = COLUMNS.map((column, i) => {
    const debt = borrowings(report.rows, column);
    return {
      year: report.year - 2 + i,
      ...pick(report.rows, INCOME, INCOME_ITEMS, column),
      ...pick(report.rows, BALANCE, BALANCE_ITEMS, column),
      ...pick(report.rows, CASH, CASH_ITEMS, column),
      borrowings: debt.amount,
      borrowingsBasis: debt.basis,
    };
  });
  return years.map((figures, i) => withRatios(figures, years[i - 1]));
}

/** The latest filed period: balance sheet at its end, income and cash flow year-to-date. */
export function latest(report) {
  const quarter = QUARTER_OF[report.reprtCode];
  const income = Object.fromEntries(
    Object.entries(INCOME_ITEMS).map(([key, item]) => {
      const row = findRow(report.rows, INCOME, item);
      return [
        key,
        quarter === 4
          ? won(row?.thstrm_amount)
          : (won(row?.thstrm_add_amount) ?? won(row?.thstrm_amount)),
      ];
    }),
  );
  const debt = borrowings(report.rows, 'thstrm_amount');
  const figures = {
    ...income,
    ...pick(report.rows, BALANCE, BALANCE_ITEMS, 'thstrm_amount'),
    ...pick(report.rows, CASH, CASH_ITEMS, 'thstrm_amount'),
    borrowings: debt.amount,
    borrowingsBasis: debt.basis,
  };
  const { roe, roa, ...rest } = withRatios(figures, null);
  return { period: `${report.year}${PERIOD_LABEL[quarter]}`, reprtCode: report.reprtCode, ...rest };
}

/** Sum of the last four quarters, or null when any is missing. */
export function trailing(quarterList, key) {
  const last = quarterList.slice(-4);
  if (last.length < 4 || last.some((q) => q[key] === null)) return null;
  return last.reduce((sum, q) => sum + q[key], 0);
}
