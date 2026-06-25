# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What KevFin is

A **self-hosted personal net-worth tracker**. It pulls bank/brokerage/credit
accounts plus real estate into one private dashboard, then layers on allocation
analysis, budgeting, cash-flow, and a Monte Carlo retirement forecast. It runs
entirely on the user's own machine — **financial data never leaves it.**

## Architecture

```
client/   React + Vite single-page app (dashboard, charts, budget, forecast)
server/   Express + TypeScript API, SQLite (better-sqlite3), daily cron history points
data/     SQLite database + backups (git-ignored — never committed)
```

- **Server** runs on port `3001`, exposes a `/api/*` REST surface, and in
  production serves the built client from the same port.
- **Client** (Vite dev server) runs on port `5173` and proxies `/api` to the server.
- **Storage** is a single SQLite file. Provider data is fetched at most ~once per
  day and cached in the DB, so the app is fast and offline-tolerant.
- Both packages are ESM (`"type": "module"`) and `strict` TypeScript.

### Server layout

- `server/src/routes/*` — thin Express handlers, one file per `/api` resource.
- `server/src/services/*` — business logic (data fetch, ingest, allocation,
  performance, budgeting, recurring detection, etc.).
- `server/src/util/*` — pure helpers (`amortization`, `taxBucket`, `categorize`,
  `assumptions`). These are dependency-free and the best place for unit tests.
- `server/src/db/schema.ts` — SQLite schema.

## Running it (development)

Requires Node 20+. Two terminals:

```bash
npm run dev --prefix server          # http://localhost:3001
npm run dev --prefix client          # http://localhost:5173
```

Or both at once from the root: `npm run dev` (uses concurrently).

Install deps: `npm run install:all` (installs both server and client).

### Demo / safe test data

Never test against real data. The seeder **refuses to run unless `DB_PATH` is
set**, so it cannot overwrite `data/kevfin.db`:

```bash
cd server
DB_PATH="$PWD/../data/demo.db" npx tsx scripts/seed-demo.ts
DB_PATH="$PWD/../data/demo.db" npm run dev
```

> Gotcha: VS Code `launch.json` injects `PORT` — be aware it can override the
> default server port when launching from the debugger.

## Build & test

```bash
npm run build                 # root: server tsc + client tsc + vite build (this is what CI runs)
npm run build --prefix server # server typecheck/build only
npm test --prefix server      # server unit tests (Vitest)
```

CI (`.github/workflows/ci.yml`) runs on every PR and push to `main`. Keep it green.

## Conventions

- **better-sqlite3 is synchronous.** Use `db.prepare(...).get/all/run(...)`. There
  is no `await` on queries; only network/provider calls are async.
- Parallelize provider/network calls with `Promise.all` (see `performance.ts`,
  `backfill.ts`, `allocation.ts`) — don't introduce serial-await waterfalls.
- Match the surrounding code's style, comment density, and naming. Files tend to
  carry explanatory comments on the non-obvious math — keep that.
- Money math lives in `util/` and the services; it must stay correct. Prefer
  adding/extending tests over "optimizing" these without a test net.

## Hard constraints (do not violate)

- **Privacy first.** Never route financial data to an external service. The app is
  designed to keep everything local.
- **The AI assistant** (`server/src/services/assistant.ts`) shells out to a
  **locally installed Claude Code binary** in headless mode — it does *not* use a
  paid API key. Queries run with `--allowedTools none`; the model only sees the
  compact financial snapshot KevFin builds and cannot read files or run tools.
  Preserve this isolation.
- **No authentication layer exists.** The app is meant for LAN / Tailscale only.
- `data/` is git-ignored; never commit the database or backups.
- Commits use the configured GitHub noreply author email (already set in git config).

## Useful entry points

- Net worth & history: `services/netWorth.ts`, `services/backfill.ts`
- Allocation look-through: `services/allocation.ts`, `services/fundHoldings.ts`
- Budgeting (largest file, ~1.7k lines): `services/budget.ts`
- Recurring-bill detection: `services/recurring.ts`
- Forecast (Monte Carlo, client-side, memoized): `client/src/pages/Forecast.tsx`
- Mortgage/amortization: `util/amortization.ts`, `services/mortgage.ts`
