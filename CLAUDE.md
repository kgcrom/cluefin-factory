# CLAUDE.md

Cluefin Factory is an agent configuration for Korean-market investment research —
a "factory" that keeps turning out company analyses and stock picks.
It is mostly Claude Code configuration (Markdown) plus docs. Run `claude` in-repo;
analyst skills live in `.claude/skills/`, the orchestrator in
`.claude/agents/market-review.md`. The agent reaches market data by shelling out to
the external cluefin CLI (`uv run cluefin-openapi-cli`) via bash — no MCP server, no
build step, no TypeScript.

It is **no longer source-free.** Deterministic steps that skills used to spell out in
prose now belong in `scripts/` (see *Code vs. skill* below). Everything else is still
Markdown.

The Pi runtime (`.pi/`, `@earendil-works/pi-coding-agent`) was removed; keeping two
runtimes in sync with a moving CLI cost more than it returned. npm is biome (formats
the JSON/config files) and vitest, which now has `scripts/` to cover.

## Commands

```bash
claude                # the actual entrypoint — no build, no install needed
npm test              # vitest run (tests/**/*.test.mjs)
npm run test:coverage # vitest with v8 coverage
npm run lint          # biome check .
npm run lint:fix      # biome check --write .
npm run format        # biome format --write .
```

There is nothing to build. npm is the lint/test toolchain; `scripts/` runs on Node
directly, with `js-yaml` and `ajv` as its only dependencies.

## Layout

```
.claude/
├── agents/market-review.md   # market-review subagent (the orchestrator)
└── skills/                   # 13 analyst skills: bull/bear-analyst, fundamental-,
                              # technical-, macro-, news-analysis, scenario-planner,
                              # final-decision, data-sanity-check, portfolio-fit,
                              # risk-position-sizing, investment-journal,
                              # decision-scorecard
docs/                         # TODO.md + assets/ (GitHub Pages source)
schemas/                      # final-decision frontmatter JSON Schema + example
scripts/                      # deterministic steps lifted out of the skills
└── scorecard.mjs             # lint / score [--write] / aggregate
tests/                        # vitest specs + fixtures
```

Investments data is per-user and git-ignored: `.claude/investments/`.

Each skill pins a model in its frontmatter: `sonnet` for rule-application, arithmetic
and recording (data-sanity-check, technical-analysis, risk-position-sizing,
investment-journal, decision-scorecard), `opus` for everything that weighs multiple
sources or argues a side.

## Code vs. skill

A step belongs in `scripts/` when the same input must always produce the same output:
schema validation, date arithmetic, predicate evaluation, return/benchmark/volatility
maths, aggregation tables, and writing computed fields back into journal frontmatter.
Writing that logic ad hoc each session costs tokens, drifts between runs, and cannot be
tested. The `invalidation` predicates (`metric`/`op`/`value`) were designed to be
machine-read — a skill should not be reading them by eye.

A step stays in a skill when it weighs evidence or writes prose: forming a thesis,
designing invalidation conditions, arguing bull vs. bear, resolving `checkable: false`
conditions with the user, and interpreting a scorecard. Skills also stay in charge of
changing the rules themselves.

**Rules live in the code that enforces them.** When a rule moves to `scripts/`, the
skill keeps how to invoke it and how to read the result, not a second copy of the rule —
two copies drift and the Markdown one wins by accident. Scripts are Node ESM (`.mjs`)
because biome and vitest already cover JS; they are not Python, even though the cluefin
CLI is. Tests live in `tests/**/*.test.mjs`.

New scripts ship with vitest coverage — that is what stops `npm test` being
decorative.

## Data sources

Market data tools shell out to the external **cluefin** CLI (`uv run
cluefin-openapi-cli`). Required keys in `.env` (see `.env.example`):
`DART_AUTH_KEY`, `KIS_APP_KEY`/`KIS_SECRET_KEY`/`KIS_ENV`.

## Gotchas

- **cluefin path:** the agent runs the CLI from `$CLUEFIN_OPENAPI_CWD`, default
  `~/workspace/cluefin`; credentials come from that directory's `.env`.
- `.claude/agents/market-review.md` holds the bash recipes for the cluefin CLI
  (price-history chunking, the DART-first financials split). With `.pi/providers/*` gone,
  the CLI's own `schema <path> --json` is the source of truth for parameter names — check
  it there before editing a recipe.
- **Latest reported earnings come from `dart financial-major-accounts`, not KIS.**
  `kis financial --div-cls-code 1` returns quarterly rows only for the stocks KIS covers
  in depth; a small cap gets annual rows that can lag a year behind the filed report. KIS
  still owns the ratios and growth rates DART does not publish. In KIS income statements
  `bsop_prti` is 영업이익 and `op_prfi` is 경상이익 — the name reads the other way.
- **Technical analysis goes through `kis chart technical`**, not raw OHLCV: the CLI pages
  the candles itself and returns indicator readings + rule votes only. Its `signal.trend`
  and `signal.mean_reversion` families are reported separately on purpose — never collapse
  them into one score. Use `chart period` (chunked, ~120 days/call) only when the candle
  rows themselves are the deliverable.
- **`kis sector daily --start-date` is an END date**, not a start: it returns the 100
  trading days ending on it (`20260901` → `20260407~20260901`). Use it for index
  benchmarks (`0001` KOSPI, `1001` KOSDAQ, `2001` KOSPI200) and split longer spans
  across calls. Prefer it over ETF proxies.
- Command discovery is `search <자연어> --json` → `schema <path> --json` → `--dry-run`;
  a bare `list --json` is a 61KB catalog dump. `--fields`/`--limit`/`--compact` keep
  responses small. Exit codes are a contract: 2 usage, 3 credentials, 4 broker/network
  (retry only if `error.retryable`), 5 rate limit.
