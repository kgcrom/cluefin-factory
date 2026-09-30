-- Schema version 2: the blind case's flow and technical blocks.

-- Foreign / institutional net buying (kiwoom analysis institutional-trend).
CREATE TABLE flows (
  symbol TEXT NOT NULL CHECK (length(symbol) = 6),
  date TEXT NOT NULL CHECK (date GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  foreign_net_qty INTEGER,
  institution_net_qty INTEGER,
  fetched_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  PRIMARY KEY (symbol, date)
) STRICT;

-- Short-sale volume (kis analysis short-selling-trend). A separate source from
-- flows, so a separate table; flowsAsOf joins them.
CREATE TABLE short_sales (
  symbol TEXT NOT NULL CHECK (length(symbol) = 6),
  date TEXT NOT NULL CHECK (date GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  short_qty INTEGER,
  fetched_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  PRIMARY KEY (symbol, date)
) STRICT;

-- `kis chart technical --end-date` readings, kept whole: the case builder
-- decides which fields survive masking. as_of is the CLI's, which is the last
-- trading day on or before the requested end date.
CREATE TABLE technical (
  symbol TEXT NOT NULL CHECK (length(symbol) = 6),
  as_of TEXT NOT NULL CHECK (as_of GLOB '[12][0-9][0-9][0-9][01][0-9][0-3][0-9]'),
  candle_count INTEGER NOT NULL CHECK (candle_count > 0),
  body TEXT NOT NULL CHECK (json_valid(body)),
  fetched_at TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL REFERENCES raw (sha256),
  PRIMARY KEY (symbol, as_of, candle_count)
) STRICT;
