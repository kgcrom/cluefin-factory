/**
 * A fake cluefin CLI over a synthetic weekday calendar (2015-06 … 2024-12).
 * It answers the paged commands the way the real ones do — the newest 100 rows
 * of the window, newest first — so paging logic is exercised without a network.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shiftDays } from '../../scripts/pit/fetch.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const technicalFixture = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/technical-005930-20240628.json'), 'utf8'),
);

// Weekdays of 2015-06 … 2024-12 stand in for the exchange calendar.
export const DAYS = [];
for (let d = '20150601'; d <= '20241231'; d = shiftDays(d, 1)) {
  const weekday = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`).getUTCDay();
  if (weekday !== 0 && weekday !== 6) DAYS.push(d);
}
export const AS_OF = '20240628';
export const closeOn = (date) => (date === AS_OF ? 81500 : 80000 + (DAYS.indexOf(date) % 7) * 100);

export function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** The newest 100 rows of a window, newest first — how the four paged commands answer. */
const window = (from, to) =>
  DAYS.filter((d) => d >= from && d <= to)
    .slice(-100)
    .reverse();

/** A fake cluefin CLI over the synthetic calendar. */
export function fakeCli(args) {
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
    const asOf = DAYS.filter((d) => d <= flag(args, '--end-date')).at(-1);
    return {
      ...technicalFixture,
      stock_code: flag(args, '--stock-code'),
      as_of: asOf,
      close: closeOn(asOf),
      candle_count: 120,
    };
  }
  if (path === 'kiwoom stock summary') {
    const kospi = flag(args, '--market-type') === '0';
    return {
      list: kospi
        ? [
            {
              code: '005930',
              name: '대형',
              listCount: '1000',
              lastPrice: '900',
              upSizeName: '대형주',
              kind: 'A',
            },
            {
              code: '005935',
              name: '대형우',
              listCount: '1000',
              lastPrice: '800',
              upSizeName: '',
              kind: 'A',
            },
            {
              code: '069500',
              name: 'ETF',
              listCount: '9000',
              lastPrice: '900',
              upSizeName: '',
              kind: 'A',
            },
            {
              code: '000660',
              name: '중형',
              listCount: '1000',
              lastPrice: '500',
              upSizeName: '중형주',
              kind: 'A',
            },
          ]
        : [
            {
              code: '247540',
              name: '코스닥',
              listCount: '1000',
              lastPrice: '700',
              kind: 'A',
              companyClassName: '우량기업',
            },
            {
              code: '400000',
              name: '어떤스팩1호',
              listCount: '1000',
              lastPrice: '5000',
              kind: 'A',
              companyClassName: '스팩',
            },
          ],
    };
  }
  throw new Error(`fake CLI: ${args.join(' ')}`);
}
