# CLAUDE.md

Cluefin Factory is an agent configuration for Korean-market investment research —
a "factory" that keeps turning out company analyses and stock picks.
There is **no source code** — the repo is Claude Code configuration (Markdown) plus
docs. Run `claude` in-repo; analyst skills live in `.claude/skills/`, the orchestrator
in `.claude/agents/market-review.md`. The agent reaches market data by shelling out to
the external cluefin CLI (`uv run cluefin-openapi-cli`) via bash — no MCP server, no
build step, no TypeScript.

The Pi runtime (`.pi/`, `@earendil-works/pi-coding-agent`) was removed; keeping two
runtimes in sync with a moving CLI cost more than it returned. What is left of npm is
biome (formats the JSON/config files) and vitest (no tests yet).

## Commands

```bash
claude                # the actual entrypoint — no build, no install needed
npm test              # vitest run --passWithNoTests (no tests today)
npm run test:coverage # vitest with v8 coverage
npm run lint          # biome check .
npm run lint:fix      # biome check --write .
npm run format        # biome format --write .
```

There is nothing to build and no runtime dependency — npm is only the lint/test
toolchain.

## Layout

```
.claude/
├── agents/market-review.md   # market-review subagent (the orchestrator)
└── skills/                   # 12 analyst skills: bull/bear-analyst, fundamental-,
                              # technical-, macro-, news-analysis, scenario-planner,
                              # final-decision, data-sanity-check, portfolio-fit,
                              # risk-position-sizing, investment-journal
docs/                         # TODO.md + assets/ (GitHub Pages source)
```

Investments data is per-user and git-ignored: `.claude/investments/`.

## Data sources

Market data tools shell out to the external **cluefin** CLI (`uv run
cluefin-openapi-cli`). Required keys in `.env` (see `.env.example`):
`DART_AUTH_KEY`, `KIS_APP_KEY`/`KIS_SECRET_KEY`/`KIS_ENV`.

## Gotchas

- **cluefin path:** the agent runs the CLI from `$CLUEFIN_OPENAPI_CWD`, default
  `~/workspace/cluefin`; credentials come from that directory's `.env`.
- `.claude/agents/market-review.md` holds the bash recipes for the cluefin CLI
  (price-history chunking, the 6-call financials bundle, the windowed-financials
  fallback). With `.pi/providers/*` gone, the CLI's own `schema <path> --json` is the
  source of truth for parameter names — check it there before editing a recipe.
- **Technical analysis goes through `kis chart technical`**, not raw OHLCV: the CLI pages
  the candles itself and returns indicator readings + rule votes only. Its `signal.trend`
  and `signal.mean_reversion` families are reported separately on purpose — never collapse
  them into one score. Use `chart period` (chunked, ~120 days/call) only when the candle
  rows themselves are the deliverable.
- Command discovery is `search <자연어> --json` → `schema <path> --json` → `--dry-run`;
  a bare `list --json` is a 61KB catalog dump. `--fields`/`--limit`/`--compact` keep
  responses small. Exit codes are a contract: 2 usage, 3 credentials, 4 broker/network
  (retry only if `error.retryable`), 5 rate limit.
