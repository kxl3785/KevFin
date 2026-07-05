# KevFin redesign & optimization plan

A phased, incremental plan to restructure KevFin around durable local data.
Each phase is independently shippable, keeps CI green, and preserves existing
databases (every schema change ships with an in-place migration). Nothing here
changes the hard constraints: local-only data, no auth layer, synchronous
better-sqlite3, single SQLite file, assistant isolation.

**The core thesis:** the app grew from "net worth dashboard" into a full
personal-finance suite, but transactions and balance history are still treated
as ephemeral provider payloads (JSON blobs in `meta`, re-parsed per request)
rather than the system of record. This plan inverts that — append-only
transactions and balance observations at the core, providers as adapters, and
every report becomes a query instead of a per-request pipeline.

---

## Phase 0 — Safety net (prerequisite for everything else)

**0.1 Golden characterization tests.** Before touching the budget pipeline,
seed `data/demo.db` (`scripts/seed-demo.ts`), capture the JSON output of
`getBudget()`, `getCashFlow()`, `getTransactionsList()`, and
`getSpendingProjection()`, and assert against those snapshots in Vitest. These
tests are the contract: every later phase must leave them byte-identical (or
change them in a reviewed commit that explains why).

**0.2 Unified migration runner.** Replace the three current mechanisms —
try/catch `ALTER TABLE` in `db/schema.ts`, lazy `CREATE TABLE` inside
`services/budget.ts`, and one-shot flags in `meta` (`cat_taxonomy_v2`,
`cc_payment_cat_v1`, …) — with numbered migrations driven by
`PRAGMA user_version`:

- `server/src/db/migrations/001-baseline.ts` … `NNN-*.ts`, applied in order
  inside a transaction.
- Migration 001 is a no-op DDL baseline that recognizes an existing database
  (all current `CREATE TABLE IF NOT EXISTS` + `ALTER` guards, run once) and
  stamps `user_version = 1`. Fresh databases get the same result.
- `getDb()` keeps its exact signature; only `migrate()` changes internally.

*Acceptance:* opening a pre-existing `kevfin.db` and a fresh DB both produce
identical `sqlite_master` contents; golden tests pass.

---

## Phase 1 — Transactions become first-class (the big one)

**1.1 Schema.**

```sql
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,   -- provider id, or sha1(account|posted|amount|payee|n) for dedup-stable synthetic ids
  account_id    TEXT NOT NULL,      -- accounts.id, or 'import:<name>' for CSV/doc imports
  source        TEXT NOT NULL,      -- 'simplefin' | 'plaid' | 'import'
  posted        TEXT NOT NULL,      -- ISO date
  transacted_at TEXT,
  amount        REAL NOT NULL,      -- + = money in (SimpleFIN convention, Plaid normalized)
  payee         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  memo          TEXT NOT NULL DEFAULT '',
  category      TEXT,               -- resolved category, stored not recomputed
  category_src  TEXT,               -- 'auto' | 'rule:<id>' | 'manual'
  amount_override REAL,             -- absorbs txn_amount_overrides
  sign_flipped  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_txn_posted   ON transactions (posted);
CREATE INDEX idx_txn_account  ON transactions (account_id, posted);
CREATE INDEX idx_txn_category ON transactions (category, posted);
```

**1.2 Ingest-on-sync.** `refreshConnection()` (SimpleFIN) and the Plaid
equivalent upsert normalized rows right after the daily fetch, instead of
consumers re-parsing the cached payload per request. Upsert never overwrites
`category` once `category_src` is `'manual'` or `'rule:*'`. The migration
ingests the current `sf_cache_*` blobs and `imported_txns` on first run, so
**no existing history is lost** — and from then on history accumulates
forever, fixing the silent 730-day cliff (`TXN_WINDOW_DAYS`) where budget
history older than the cache window currently vanishes.

**1.3 One rules table.** Collapse `txn_rules`, `txn_base_rules`,
`txn_sign_rules`, `txn_sign_base_rules`, `txn_smart_rules` into:

```sql
CREATE TABLE rules (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  matcher  TEXT NOT NULL,   -- 'merchant' | 'base' | 'smart' (payee+amount predicates)
  pattern  TEXT NOT NULL,   -- JSON predicate for 'smart', plain string otherwise
  action   TEXT NOT NULL,   -- 'categorize:<cat>' | 'flip-sign'
  priority INTEGER NOT NULL DEFAULT 0
);
```

Editing a rule re-runs it over matching rows (`UPDATE … WHERE`), instead of
changing behavior implicitly on the next full recompute. Migration converts
every existing row from the five tables and drops them.

**1.4 Reports become SQL.** `getBudget`, `getCashFlow`, `getTransactionsList`,
`getReviewQueue`, `getSpendingProjection` read from `transactions` with
indexed queries. `budget.ts` (1.8k lines) splits by responsibility:

- `services/txnIngest.ts` — normalization, dedup, rule application
- `services/rules.ts` — rules CRUD + re-application
- `services/categories.ts` — taxonomy, labels, groups (mostly extracted as-is)
- `services/budget.ts` — pure reporting, small

*Acceptance:* golden tests from 0.1 unchanged; a synthetic test proving
transactions older than 730 days survive a cache refresh.

---

## Phase 2 — Balance history as observations, not reconstructions

**2.1 Schema.**

```sql
CREATE TABLE balance_observations (
  account_id TEXT NOT NULL,   -- accounts.id, 'property:<id>', or 'manual:<id>'
  date       TEXT NOT NULL,
  balance    REAL NOT NULL,
  estimated  INTEGER NOT NULL DEFAULT 0,  -- 1 = backfill-derived, replaced by real data when seen
  PRIMARY KEY (account_id, date)
);
```

**2.2 Write on every sync** (and from the daily cron), keyed by the provider's
`balance-date`. `net_worth_snapshots` becomes a derived view over
observations; keep the physical table during a deprecation window, written
from the same code path, so nothing downstream breaks.

**2.3 Backfill demotes to estimator.** `backfill.ts` stops being load-bearing:
it writes `estimated = 1` observations for dates before real data exists, and
real observations always win. Per-account history also unlocks per-account
charts and cleaner performance attribution in `performance.ts` later, for free.

*Acceptance:* net-worth chart identical on an existing DB; deleting and
re-running backfill never clobbers a real observation.

---

## Phase 3 — Provider adapters behind one interface

Define the canonical internal model (`NormalizedAccount`, `NormalizedTxn`,
`NormalizedHolding`) in one module and make SimpleFIN, Plaid, and CSV/document
import three adapters that emit it. The sign convention ("+ = money in")
becomes a type-level contract instead of a comment. `imported_txns` and
`reconcileImported()` disappear — imports are just a third source writing to
`transactions` with `source = 'import'`.

---

## Phase 4 — Client structure

- **Add `react-router-dom` and `@tanstack/react-query`.** Routes replace the
  hand-rolled `View` state in `TopNav`; query invalidation replaces the
  `DATA_CHANGED_EVENT` window-event bus.
- **Extract the dashboard out of `App.tsx`** (1.3k lines) into
  `pages/Dashboard.tsx`; `App.tsx` becomes shell + routes + providers.
- **Split `Forecast.tsx`** (1.9k lines): the sim already lives in
  `lib/forecastSim.ts` (keep); extract `ForecastControls` and `ForecastResults`.
- **Shared API types.** New `shared/` directory (path-mapped into both
  tsconfigs) holding the REST response interfaces both sides import today by
  hand-copying (`Account`, `Property`, `ManualAsset`, `BudgetSummary`, …).
  Server route handlers annotate their responses with these types; the client
  deletes its local mirrors. Booleans cross the boundary as booleans — the
  `hidden: number // 0/1 from SQLite` convention gets converted at the route
  layer, not in the UI.

Each bullet is its own PR-sized change; router + query first since the page
extractions get easier after it.

---

## Quick wins (independent, can ship immediately, any order)

| # | Change | Where | Why |
|---|--------|-------|-----|
| Q1 | Parallelize the per-connection loops with `Promise.all` | `simplefin.ts:140,176,199` (`fetchHoldings`, `fetchTransactions`, `getAllTransactions`) | Serial awaited network calls on cold start; CLAUDE.md already mandates the pattern used in `performance.ts`/`backfill.ts` |
| Q2 | Add the missing indexes (there are currently **zero** `CREATE INDEX` in the codebase) | migration | `net_worth_snapshots(date)` is UNIQUE (ok); `property_value_history`, `imported_txns(date)` and later `transactions` need them |
| Q3 | Move `sf_cache_*` blobs out of `meta` into a `provider_cache(key, fetched_at, payload)` table | `simplefin.ts` | `meta` mixes settings, migration flags, and multi-MB JSON; backups and `getMetaValue` scans shouldn't drag payloads along |
| Q4 | Stable synthetic txn ids | `simplefin.ts:204` | `${id}-${posted}-${amount}` collides for two identical same-day purchases; hash in payee + an occurrence counter |
| Q5 | Extract the category taxonomy/labels block out of `budget.ts` into `categories.ts` | budget.ts lines ~14–500 | Pure code motion, shrinks the hotspot before Phase 1 touches it |

## Explicitly deferred / rejected

- **Integer-cents money.** Correct in a from-scratch design, but retrofitting
  touches every table, route, and chart for little user-visible gain at
  personal scale. Revisit only if penny drift is ever observed in budget math.
- **Auth layer, ORM, Postgres, async DB driver, tRPC.** The unfashionable
  choices (LAN-only, raw SQL, synchronous better-sqlite3, plain REST) are
  right for a single-user local app. Keep them.
- **Server-side forecast.** Client-side Monte Carlo keeps the server stateless
  and fast; `forecastSim.ts` is already extracted and tested.

## Sequencing & effort

| Order | Work | Size | Risk |
|-------|------|------|------|
| 1 | Q1–Q5 quick wins | S | low |
| 2 | Phase 0 (golden tests + migration runner) | M | low |
| 3 | Phase 1 (transactions + rules) | L | medium — mitigated by 0.1 |
| 4 | Phase 2 (observations) | M | low |
| 5 | Phase 3 (adapters) | M | low |
| 6 | Phase 4 (client) | M–L | low, mechanical |

Rollback story throughout: every migration is forward-only but each phase
keeps the old read path behind the golden tests until its replacement matches,
and `data.ts` backups (`pre-restore-*.db` pattern) are taken before the Phase 1
data migration runs.
