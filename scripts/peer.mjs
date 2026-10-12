#!/usr/bin/env node
/**
 * US peer filings — which SEC filings to read for one US customer or competitor.
 *
 *   node scripts/peer.mjs pick --ticker MU [--as-of YYYYMMDD]
 *
 * Prints one JSON object: the company's CIK, its newest 10-K or 10-Q filed by `as-of` with
 * the Item table of contents, its newest results 8-K (item 2.02), and the CLI commands that
 * read them. The text itself is not fetched: risk factors and MD&A run 20k–120k characters
 * per Item, and how much of them a report needs is the analyst's call.
 *
 * Who counts as a peer is a skill's judgment (fundamental-analysis / news-analysis); this
 * only makes "the latest filings of ticker X" the same answer on every run.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { CluefinError, run } from './lib/cluefin.mjs';
import { kstClock } from './lib/kst.mjs';

/** Items that carry demand, capex and inventory commentary: risk factors and MD&A. */
export const READ_ITEMS = { '10-K': ['1A', '7'], '10-Q': ['II:1A', 'I:2'] };
export const EARNINGS_EXHIBIT = 'EX-99.1';
const CLI = 'uv run cluefin-openapi-cli';

const compact = (isoDate) => String(isoDate ?? '').replaceAll('-', '');

/**
 * Newest filing of `forms` filed by `asOf`. Amendments are left out: a 10-K/A is usually
 * Part III only, and an 8-K/A rarely restates the results.
 */
function newest(cli, cik, forms, asOf, extra = []) {
  const payload = cli([
    'sec',
    'filings',
    '--cik',
    String(cik),
    '--forms',
    forms,
    '--include-amendments',
    'false',
    '--max-rows',
    '40',
    ...extra,
  ]);
  const filing = (payload.data ?? []).find((f) => compact(f.filing_date) <= asOf) ?? null;
  return { payload, filing };
}

const filingOf = (f) => ({
  form: f.form,
  accessionNumber: f.accession_number,
  filingDate: f.filing_date,
  reportDate: f.report_date,
});

function itemsToc(cli, cik, accessionNumber) {
  const toc = cli([
    'sec',
    'filing-items',
    '--cik',
    String(cik),
    '--accession-number',
    accessionNumber,
  ]);
  return {
    missing: toc.missing ?? [],
    omitted: toc.omitted ?? [],
    items: (toc.items ?? []).map((i) => ({
      key: i.key,
      title: i.title,
      chars: i.chars,
      uncertain: i.uncertain,
      warnings: i.warnings,
      incorporatedByReference: i.incorporated_by_reference,
    })),
  };
}

const FLAGS = new Set(['ticker', 'as-of']);

/** The `pick` command. Null on a usage error. */
export function pick(flags, { cli = run, now = new Date() } = {}) {
  if (Object.keys(flags).some((key) => !FLAGS.has(key))) return null;
  const ticker = flags.ticker?.toUpperCase();
  const asOfFlag = flags['as-of'];
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker ?? '')) return null;
  if (asOfFlag && !/^\d{8}$/.test(asOfFlag)) return null;
  const asOf = asOfFlag ?? kstClock(now).date;

  const company = cli(['sec', 'company-lookup', '--ticker', ticker]).data?.[0];
  if (!company) throw new Error(`SEC에 없는 티커다: ${ticker}`);
  const { cik } = company;

  const periodic = newest(cli, cik, '10-K,10-Q', asOf);
  const earnings = newest(cli, cik, '8-K', asOf, ['--items', '2.02']);
  const meta = periodic.payload;
  // The CLI names the forms it did find when none match; 20-F/6-K means a foreign private issuer.
  const foreignPrivateIssuer = !periodic.filing && /20-F|6-K/.test(meta.hint ?? '');

  const next = [];
  let periodicOut = null;
  if (periodic.filing) {
    const { accession_number: accession, form } = periodic.filing;
    const read = READ_ITEMS[form];
    periodicOut = { ...filingOf(periodic.filing), read, ...itemsToc(cli, cik, accession) };
    for (const key of read) {
      next.push(
        `${CLI} sec filing-items --cik ${cik} --accession-number ${accession} --items ${key} --json`,
      );
    }
  }
  let earningsOut = null;
  if (earnings.filing) {
    earningsOut = { ...filingOf(earnings.filing), exhibit: EARNINGS_EXHIBIT };
    next.push(
      `${CLI} sec filing-exhibit --cik ${cik} --accession-number ${earnings.filing.accession_number} --exhibit ${EARNINGS_EXHIBIT} --json`,
    );
  }

  return {
    ticker,
    cik,
    name: meta.name ?? company.name,
    sic: meta.sic_description ?? null,
    fiscalYearEnd: meta.fiscal_year_end ?? null,
    asOf,
    foreignPrivateIssuer,
    periodic: periodicOut,
    earnings: earningsOut,
    next,
  };
}

const USAGE = 'usage: node scripts/peer.mjs pick --ticker <US ticker> [--as-of YYYYMMDD]';

export async function main(argv, deps = {}) {
  const { command, flags, error } = parseArgs(argv);
  if (error || command !== 'pick') {
    console.error(error ?? USAGE);
    return 2;
  }
  let result;
  try {
    result = pick(flags, deps);
  } catch (cause) {
    const code = cause instanceof CluefinError ? cause.code : 1;
    console.error(JSON.stringify({ error: { message: cause.message, exit_code: code } }));
    return code;
  }
  if (result === null) {
    console.error(USAGE);
    return 2;
  }
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
