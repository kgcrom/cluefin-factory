# CLAUDE.md

Cluefin Factory is an agent configuration for Korean-market investment research —
a "factory" that keeps turning out company analyses and stock picks.
There is **no `src/`** — all code and config live under `.pi/` and `.claude/`.
It runs on **two agent runtimes**, both backed by the external cluefin CLI:

- **Pi** — `npm run chat` launches `@earendil-works/pi-coding-agent` against the
  `.pi/` setup (extension `index.ts`, `/market-review` prompt, `.pi/skills/`).
  Tools call cluefin via `.pi/extensions/market-data/` (`cli.ts`/`providers/*`).
- **Claude Code** — run `claude` in-repo; analyst skills live in `.claude/skills/`,
  the orchestrator in `.claude/agents/market-review.md`. The agent calls the
  cluefin CLI directly via bash (no MCP server, no build required).

So the runtimes differ in *how* they reach cluefin: Pi registers TS tools
(`index.ts`), Claude Code shells out to `uv run cluefin-openapi-cli` from the
`market-review` agent.

## Commands

```bash
npm run chat          # launch the Pi agent (reads .env)
npm run build         # tsc -> dist/ (compiles .pi/**/*.ts for the Pi runtime)
npm test              # vitest run --passWithNoTests
npm run test:coverage # vitest with v8 coverage
npm run lint          # biome check .
npm run lint:fix      # biome check --write .
npm run format        # biome format --write .
```

`npm run build` is only needed for the Pi runtime. Claude Code needs no build —
the `market-review` agent shells out to the cluefin CLI directly.

## Layout

```
.pi/
├── extensions/market-data/   # Pi tools (kis_*, dart_*, market_data_health)
│   ├── index.ts              # Pi tool registration entrypoint
│   ├── cli.ts                # bridge to external cluefin CLI
│   └── providers/            # dart.ts, kis.ts (runtime-agnostic)
├── prompts/market-review.md  # /market-review prompt (Pi)
└── skills/                   # 12 analyst skills: bull/bear-analyst, fundamental-,
                              # technical-, macro-, news-analysis, scenario-planner,
                              # final-decision, data-sanity-check, portfolio-fit,
                              # risk-position-sizing, investment-journal
.claude/
├── agents/market-review.md   # market-review subagent (Claude Code orchestrator)
└── skills/                   # same 12 analyst skills, ported as SKILL.md
docs/                         # TODO.md + assets/ (GitHub Pages source)
```

Investments data is per-user and git-ignored: `.pi/investments/` (Pi) and
`.claude/investments/` (Claude Code).

## Data sources

Market data tools shell out to the external **cluefin** CLI (`uv run
cluefin-openapi-cli`). Required keys in `.env` (see `.env.example`):
`DART_AUTH_KEY`, `KIS_APP_KEY`/`KIS_SECRET_KEY`/`KIS_ENV`.

## Gotchas

- **cluefin path env var:** code reads `CLUEFIN_OPENAPI_CWD`
  (`.pi/extensions/market-data/cli.ts:9`); default fallback is `~/workspace/cluefin`.
- TS build targets `.pi/**/*.ts` only (`tsconfig.json` `include`); output goes to
  `dist/` and is consumed only by the Pi runtime.
- The Claude Code `market-review` agent (`.claude/agents/market-review.md`) holds
  bash recipes for the cluefin CLI subcommands. `providers/kis.ts`/`dart.ts` are the
  source of truth for subcommand/param mappings (esp. price-history chunking,
  the 6-call financials bundle, and windowed-financials fallback) — keep the agent
  recipes in sync with them.
