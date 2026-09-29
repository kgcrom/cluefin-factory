import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  averageFill,
  classify,
  executionOf,
  linkTrades,
  parseTransactions,
} from '../scripts/lib/execution.mjs';
import { execution } from '../scripts/scorecard.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DECISIONS = join(ROOT, 'tests/fixtures/decisions');

const HEADER = 'date,symbol,side,quantity,price,fee,note,decision_id';

const buy = {
  decision_id: '2026-07-10-383220-01',
  decided_at: '2026-07-10T16:00:00+09:00',
  symbol: '383220',
  verdict: 'buy',
  reference: { price: 77600 },
  levels: { entry: { min: 77000, max: 78500 } },
  scoring: { status: 'invalidated', price_at_review: 74400, return_pct: -4.12 },
};

const trade = (overrides) => ({
  line: 2,
  date: '20260713',
  symbol: '383220',
  side: 'buy',
  quantity: 10,
  price: 78000,
  fee: 0,
  decision_id: buy.decision_id,
  ...overrides,
});

describe('CSV 읽기', () => {
  it('따옴표 안의 쉼표를 칸으로 자르지 않고, 날짜 구분자를 없앤다', () => {
    const rows = parseTransactions(
      `${HEADER}\n2026-07-13,383220,BUY,10,78000,150,"분할, 1차",2026-07-10-383220-01\n`,
    );
    expect(rows).toEqual([
      {
        line: 2,
        date: '20260713',
        symbol: '383220',
        side: 'buy',
        quantity: 10,
        price: 78000,
        fee: 150,
        decision_id: '2026-07-10-383220-01',
      },
    ]);
  });

  it('decision_id 열이 없는 옛 파일도 읽고, 전부 연결 없음이 된다', () => {
    const rows = parseTransactions(
      'date,symbol,side,quantity,price,fee,note\n2026-07-13,383220,buy,10,78000,0,\n',
    );
    expect(rows[0].decision_id).toBeNull();
    expect(classify(rows[0], undefined)).toBe('unlinked');
  });

  it('헤더뿐이면 빈 목록이다', () => {
    expect(parseTransactions(`${HEADER}\n`)).toEqual([]);
  });
});

describe('판단과의 관계', () => {
  it('verdict와 같은 방향이면 followed, 반대면 against다', () => {
    expect(classify(trade({}), buy)).toBe('followed');
    expect(classify(trade({ side: 'sell' }), buy)).toBe('against');
    expect(classify(trade({}), { ...buy, verdict: 'watch' })).toBe('against');
    expect(classify(trade({ side: 'sell' }), { ...buy, verdict: 'sell' })).toBe('followed');
  });

  it('hold에 추가 매수, watch에 매도는 판단이 말하지 않은 것이라 neutral이다', () => {
    expect(classify(trade({}), { ...buy, verdict: 'hold' })).toBe('neutral');
    expect(classify(trade({ side: 'sell' }), { ...buy, verdict: 'watch' })).toBe('neutral');
  });

  it('없는 판단·다른 종목·판단 전 매매를 구분한다', () => {
    expect(classify(trade({}), undefined)).toBe('unknown_decision');
    expect(classify(trade({ symbol: '005930' }), buy)).toBe('symbol_mismatch');
    expect(classify(trade({ date: '20260709' }), buy)).toBe('before_decision');
  });
});

describe('실행 성과', () => {
  it('평균 체결가에 수수료를 얹는다 — 매수는 더하고 매도는 뺀다', () => {
    expect(averageFill([trade({ quantity: 10, price: 78000, fee: 1000 })])).toBe(78100);
    expect(averageFill([trade({ side: 'sell', quantity: 10, price: 78000, fee: 1000 })])).toBe(
      77900,
    );
  });

  it('기준가 대비 체결 갭과 채점 시점까지의 실행 수익률을 판단 수익률과 나란히 낸다', () => {
    // 78,000에 샀고 기준가는 77,600: 0.52% 비싸게 샀다. 74,400까지 -4.62%, 판단은 -4.12%
    expect(executionOf(buy, [trade({})])).toEqual({
      side: 'buy',
      quantity: 10,
      average_fill: 78000,
      fill_gap_pct: 0.52,
      in_entry_range: true,
      execution_return_pct: -4.62,
      judgment_return_pct: -4.12,
    });
  });

  it('매도는 scoring과 같은 부호 규칙을 쓴다 — 판 뒤 떨어졌으면 양수다', () => {
    const sell = {
      ...buy,
      verdict: 'sell',
      reference: { price: 64900 },
      levels: {},
      scoring: { price_at_review: 67300, return_pct: -3.7 },
    };
    const result = executionOf(sell, [trade({ side: 'sell', price: 65000 })]);
    // 65,000에 팔았는데 67,300으로 올랐다: -3.54%. 기준가보다 100원 비싸게 팔아 갭은 음수(유리)
    expect(result).toMatchObject({ execution_return_pct: -3.54, fill_gap_pct: -0.15 });
    expect(result.in_entry_range).toBeNull();
  });

  it('진입 구간을 벗어난 체결이 하나라도 있으면 false다', () => {
    expect(executionOf(buy, [trade({}), trade({ price: 79000 })]).in_entry_range).toBe(false);
  });

  it('채점 전 판단은 실행 수익률을 비우고 성과 표본에서 뺀다', () => {
    const open = { ...buy, scoring: { status: 'pending' } };
    const report = linkTrades([trade({})], [{ data: open }]);
    expect(report.decisions[0].execution_return_pct).toBeNull();
    expect(report.performance.n).toBe(0);
  });
});

describe('linkTrades', () => {
  it('매매마다 분류해 세고, 문제 있는 줄은 따로 짚는다', () => {
    const report = linkTrades(
      [
        trade({ line: 2 }),
        trade({ line: 3, price: 77000 }),
        trade({ line: 4, decision_id: null }),
        trade({ line: 5, decision_id: 'no-such-id' }),
      ],
      [{ data: buy }],
    );
    expect(report.counts).toMatchObject({ followed: 2, unlinked: 1, unknown_decision: 1 });
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]).toMatchObject({ quantity: 20, average_fill: 77500 });
    expect(report.problems).toEqual([
      { line: 5, decision_id: 'no-such-id', link: 'unknown_decision' },
    ]);
  });
});

describe('execution CLI', () => {
  it('journal과 transactions.csv를 읽어 연결한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'execution-'));
    const csv = join(dir, 'transactions.csv');
    writeFileSync(csv, `${HEADER}\n2026-07-13,383220,buy,10,78000,0,,2026-07-10-383220-01\n`);
    const report = execution([DECISIONS], { transactions: csv });
    expect(report.counts.followed).toBe(1);
    // 픽스처는 pending이라 실행 수익률은 아직 없다
    expect(report.decisions[0]).toMatchObject({ fill_gap_pct: 0.52, execution_return_pct: null });
  });

  it('transactions.csv가 없으면 빈 보고서다', () => {
    const report = execution([DECISIONS], { transactions: '/nonexistent.csv' });
    expect(report.decisions).toEqual([]);
  });
});
