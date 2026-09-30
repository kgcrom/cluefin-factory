-- PIT store, schema version 1.
--
-- raw holds every CLI response as received; the fact tables are rebuilt from it
-- (scripts/pit/db.mjs rebuild). Dates are TEXT YYYYMMDD: lexical order is time
-- order, and it is the form the CLI speaks. known_at is the first trading day a
-- value could have been acted on — every as-of query filters on it.

CREATE TABLE raw (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  source TEXT NOT NULL,
  params TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  body TEXT NOT NULL
) STRICT;

CREATE INDEX raw_source ON raw (source, fetched_at);

-- Adjusted daily candles. Adjustment is recomputed by the broker at fetch time;
-- a later fetch replaces the row and fetched_at records which one is held.
CREATE TABLE prices (
  symbol TEXT NOT NULL CHECK (length(symbol) = 6),
  date TEXT NOT NULL CHECK (date GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  open INTEGER NOT NULL CHECK (open >= 0),
  high INTEGER NOT NULL CHECK (high >= 0),
  low INTEGER NOT NULL CHECK (low >= 0),
  close INTEGER NOT NULL CHECK (close > 0),
  volume INTEGER NOT NULL CHECK (volume >= 0),
  value INTEGER CHECK (value >= 0),
  fetched_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  PRIMARY KEY (symbol, date)
) STRICT;

-- Index closes. The 0001 (KOSPI) dates double as the trading calendar.
CREATE TABLE index_prices (
  sector_code TEXT NOT NULL CHECK (length(sector_code) = 4),
  date TEXT NOT NULL CHECK (date GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  close REAL NOT NULL CHECK (close > 0),
  fetched_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  PRIMARY KEY (sector_code, date)
) STRICT;

CREATE TABLE disclosures (
  rcept_no TEXT PRIMARY KEY CHECK (length(rcept_no) = 14),
  corp_code TEXT NOT NULL CHECK (length(corp_code) = 8),
  rcept_dt TEXT NOT NULL CHECK (rcept_dt GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  known_at TEXT NOT NULL CHECK (known_at GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  report_nm TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  CHECK (known_at > rcept_dt)
) STRICT;

CREATE INDEX disclosures_asof ON disclosures (corp_code, known_at);

-- Financial statements in long form: one account of one filing per row. Every
-- filing of a period is kept (original and each amendment), so an as-of query
-- can pick the one that was public at the time.
CREATE TABLE financials (
  corp_code TEXT NOT NULL CHECK (length(corp_code) = 8),
  bsns_year INTEGER NOT NULL CHECK (bsns_year BETWEEN 1990 AND 2100),
  reprt_code TEXT NOT NULL CHECK (reprt_code IN ('11013', '11012', '11014', '11011')),
  fs_div TEXT NOT NULL CHECK (fs_div IN ('CFS', 'OFS')),
  account_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  is_cumulative INTEGER NOT NULL CHECK (is_cumulative IN (0, 1)),
  period_end TEXT NOT NULL CHECK (period_end GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  rcept_no TEXT NOT NULL CHECK (length(rcept_no) = 14),
  known_at TEXT NOT NULL CHECK (known_at GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  UNIQUE (corp_code, bsns_year, reprt_code, fs_div, account_id, is_cumulative, rcept_no),
  CHECK (known_at > period_end)
) STRICT;

CREATE INDEX financials_asof ON financials (corp_code, known_at);
