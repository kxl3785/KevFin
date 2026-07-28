import type Database from 'better-sqlite3';
import {
  CATEGORIES, TAXONOMY_MIGRATION, GROUP_MERGES, ensureImportedCategories,
} from '../services/taxonomy.js';
import {
  rawTxnsFromSimpleFin, syncFeedTransactions, FEED_WINDOW_DAYS,
  type RawTxn, type SimpleFinFeedAccount,
} from '../services/feedStore.js';

// Numbered schema migrations, driven by PRAGMA user_version. Each runs at most
// once per database, inside a transaction, in order. This replaces the three
// mechanisms that grew organically: try/catch ALTERs in schema.ts, lazy CREATEs
// in the budget service, and one-shot flags in the meta table.
//
// Migration 001 is the consolidated baseline. It is exactly the idempotent DDL
// the app used to run on every boot, so it recognizes any existing database
// (whatever mix of columns/flags it has) and brings it to the same state a
// fresh database gets. The meta-flag guards inside it are kept deliberately:
// on an old database the flags record which one-shot data migrations already
// ran, and they must not run twice.

type Db = Database.Database;

export interface Migration { version: number; name: string; up: (db: Db) => void }

const addColumn = (db: Db, sql: string) => { try { db.exec(sql); } catch { /* column exists */ } };

function baseline(db: Db) {
  // One-time cleanup of the original Plaid-only accounts table. It is identified
  // by having `plaid_item_id` but NOT the `source` column that the current
  // (SimpleFIN + Plaid hybrid) schema adds. Never drop the current table —
  // doing so wipes account data on every restart.
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('accounts')`).all() as { name: string }[])
    .map(c => c.name);
  if (cols.includes('plaid_item_id') && !cols.includes('source')) {
    db.exec(`DROP TABLE IF EXISTS accounts;`);
  }
  // Legacy Plaid items table used `id` as PK; the current one uses `item_id`.
  const piCols = (db.prepare(`SELECT name FROM pragma_table_info('plaid_items')`).all() as { name: string }[])
    .map(c => c.name);
  if (piCols.length > 0 && !piCols.includes('item_id')) {
    db.exec(`DROP TABLE IF EXISTS plaid_items;`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS simplefin_connections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      access_url  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id          TEXT PRIMARY KEY,
      access_token     TEXT NOT NULL,
      institution_name TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,            -- provider account id
      source        TEXT NOT NULL DEFAULT 'simplefin',  -- 'simplefin' | 'plaid'
      connection_id INTEGER,                     -- simplefin_connections.id (simplefin)
      plaid_item_id TEXT,                        -- plaid_items.item_id (plaid)
      org_name      TEXT NOT NULL,              -- institution, e.g. "Fidelity"
      name          TEXT NOT NULL,              -- account name
      currency      TEXT NOT NULL DEFAULT 'USD',
      balance       REAL NOT NULL DEFAULT 0,
      category      TEXT NOT NULL DEFAULT 'other',
      custom_name   TEXT,
      hidden        INTEGER NOT NULL DEFAULT 0,
      balance_date  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS manual_assets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'other',
      value         REAL NOT NULL DEFAULT 0,
      -- Annual growth/interest rate (percent, e.g. 4.5). NULL = no rate set: the
      -- Forecast leaves it in the volatile investment pool (legacy behavior). When
      -- set, the Forecast grows it steadily at this rate instead. A liability
      -- (negative value) compounds the same way — its debt grows.
      interest_rate REAL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS properties (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      address          TEXT NOT NULL UNIQUE,
      zestimate        REAL,
      mortgage_balance REAL NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Provider payload cache (SimpleFIN /accounts, Plaid transactions). Kept out
    -- of meta so multi-MB blobs don't share a table with small settings.
    CREATE TABLE IF NOT EXISTS provider_cache (
      key        TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      payload    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      date              TEXT NOT NULL UNIQUE,
      accounts_total    REAL NOT NULL,
      real_estate_total REAL NOT NULL,
      net_worth         REAL NOT NULL
    );

    -- Manually-entered per-property home-value (Zestimate) history. When present
    -- for a property, the backfill uses these points directly instead of the
    -- (smoothed) ZHVI curve — capturing the real month-to-month movement.
    CREATE TABLE IF NOT EXISTS property_value_history (
      property_id INTEGER NOT NULL,
      date        TEXT NOT NULL,
      value       REAL NOT NULL,
      PRIMARY KEY (property_id, date)
    );

    -- Manual asset-class overrides for the allocation view, keyed by the holding's
    -- display symbol (or name when untickered). Lets the user fix mis-bucketed or
    -- "Uncategorized" holdings; applied consistently across every allocation panel.
    CREATE TABLE IF NOT EXISTS asset_class_overrides (
      symbol      TEXT PRIMARY KEY,
      asset_class TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Manual cost-basis overrides for the allocation/positions view, keyed by the
    -- same holdingId (display symbol, or name when untickered). Lets the user fill
    -- in or correct a position's total cost basis when the institution doesn't
    -- report one (or reports it wrong); takes precedence over any derived basis.
    CREATE TABLE IF NOT EXISTS cost_basis_overrides (
      symbol      TEXT PRIMARY KEY,
      cost_basis  REAL NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cost basis pulled from an imported document (e.g. a 1099-B or broker
    -- positions statement). Same holdingId key, but a distinct source so it ranks
    -- below a manual override and above the feed-reported basis (see allocation).
    CREATE TABLE IF NOT EXISTS imported_cost_basis (
      symbol      TEXT PRIMARY KEY,
      cost_basis  REAL NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cached fund holdings from SEC EDGAR N-PORT filings (services/edgarHoldings).
    -- Filings are quarterly, so a long TTL is safe and keeps the app offline-
    -- tolerant. holdings is a JSON Constituent[]; NULL records a symbol EDGAR
    -- has no filing for (negative cache), as_of is the filing's report date.
    CREATE TABLE IF NOT EXISTS edgar_fund_holdings (
      symbol     TEXT PRIMARY KEY,
      as_of      TEXT,
      holdings   TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Budget: rules, targets, categories, imports (previously created lazily by
    -- the budget service on first use).
    CREATE TABLE IF NOT EXISTS txn_rules (merchant TEXT PRIMARY KEY, category TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS txn_base_rules (base TEXT PRIMARY KEY, category TEXT NOT NULL);
    -- Merchants whose amount sign should be reversed (e.g. a mortgage/credit-card
    -- payment that posts as a positive credit but is really money out). Applies to
    -- existing and future transactions for that merchant. txn_sign_rules matches an
    -- exact merchant key; txn_sign_base_rules matches a normalised merchant base
    -- (like txn_base_rules) so name variants — "Bilt Housing", "Bilt Housing #42" —
    -- and future transactions from the same merchant are all caught.
    CREATE TABLE IF NOT EXISTS txn_sign_rules (merchant TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS txn_sign_base_rules (base TEXT PRIMARY KEY);
    -- Generalized "smart" rules: each non-null condition must hold (AND). 'base'
    -- matches the normalised merchant, 'contains' a lowercased substring of
    -- payee+description, 'amount' an exact absolute amount. Apply to existing and
    -- future transactions; the most specific (most conditions) wins.
    CREATE TABLE IF NOT EXISTS txn_smart_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base TEXT, contains TEXT, amount REAL,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS budget_targets (category TEXT PRIMARY KEY, monthly_limit REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_categories (name TEXT PRIMARY KEY, sort INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS imported_txns (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL,
      payee TEXT NOT NULL, merchant TEXT NOT NULL, account TEXT NOT NULL, category TEXT
    );
    -- Per-transaction amount overrides keyed by transaction id. Stores the absolute
    -- amount; the original sign (expense/income) is preserved when applied.
    CREATE TABLE IF NOT EXISTS txn_amount_overrides (id TEXT PRIMARY KEY, amount REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_imported_txns_date ON imported_txns (date);
  `);

  // Column upgrades for databases created before these features existed.
  addColumn(db, `ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT 'other'`);
  addColumn(db, `ALTER TABLE accounts ADD COLUMN custom_name TEXT`);
  addColumn(db, `ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'simplefin'`);
  addColumn(db, `ALTER TABLE accounts ADD COLUMN plaid_item_id TEXT`);
  addColumn(db, `ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  // Annual growth/interest rate for manual assets, added after they were value-only.
  addColumn(db, `ALTER TABLE manual_assets ADD COLUMN interest_rate REAL`);
  // Mortgage amortization inputs. When principal + rate + start are all set,
  // mortgage_balance is recomputed from a standard amortization schedule
  // (see services/mortgage.ts) instead of being entered manually.
  addColumn(db, `ALTER TABLE properties ADD COLUMN mortgage_principal REAL`);
  addColumn(db, `ALTER TABLE properties ADD COLUMN mortgage_rate REAL`);
  addColumn(db, `ALTER TABLE properties ADD COLUMN mortgage_start TEXT`);
  addColumn(db, `ALTER TABLE properties ADD COLUMN mortgage_term_years INTEGER`);
  // Recurring carrying costs (annual $). Surfaced in the Budget housing breakdown
  // and modeled — each at its own growth rate — in the Forecast. Net worth is
  // unaffected (these are cash costs, not assets/liabilities).
  addColumn(db, `ALTER TABLE properties ADD COLUMN property_tax_annual REAL`);
  addColumn(db, `ALTER TABLE properties ADD COLUMN insurance_annual REAL`);
  addColumn(db, `ALTER TABLE properties ADD COLUMN hoa_annual REAL`);
  // Income the property generates (annual $) — e.g. rent. Offsets the carrying
  // costs in the Budget breakdown and adds to cash flow in the Forecast.
  addColumn(db, `ALTER TABLE properties ADD COLUMN rental_income_annual REAL`);
  // Per-property opt-out of the investment asset-allocation view (e.g. a primary
  // residence). Does not affect net worth — only the allocation breakdown.
  addColumn(db, `ALTER TABLE properties ADD COLUMN excluded_from_allocation INTEGER NOT NULL DEFAULT 0`);
  // `name` is the stable canonical id used everywhere internally; `label` is an
  // optional display rename and `emoji` an optional icon override, both applied
  // only at the UI boundary so the rest of the system never has to change.
  addColumn(db, `ALTER TABLE budget_categories ADD COLUMN label TEXT`);
  addColumn(db, `ALTER TABLE budget_categories ADD COLUMN emoji TEXT`);
  // Optional group override (reclassify a category into a different group). NULL =
  // use the taxonomy default. `sort` drives the user-controlled ordering.
  addColumn(db, `ALTER TABLE budget_categories ADD COLUMN grp TEXT`);
  // Budget targets can be monthly or annual (e.g. Travel, Insurance — lumpy yearly spend).
  addColumn(db, `ALTER TABLE budget_targets ADD COLUMN period TEXT NOT NULL DEFAULT 'monthly'`);
  // Imported rows start unreviewed; the user fixes their category and "accepts" them.
  addColumn(db, `ALTER TABLE imported_txns ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0`);

  // One-time move of provider cache blobs out of meta into provider_cache. The
  // old entries were {fetchedAt, accounts} / {fetchedAt, txns} envelopes; the new
  // table stores the inner array as the payload with fetched_at as a column.
  const legacyBlobs = db.prepare(
    `SELECT key, value FROM meta WHERE key LIKE 'sf_cache_%' OR key LIKE 'plaid_txn_cache_%'`
  ).all() as { key: string; value: string }[];
  const insBlob = db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)');
  for (const b of legacyBlobs) {
    try {
      const parsed = JSON.parse(b.value) as { fetchedAt?: number; accounts?: unknown; txns?: unknown };
      const payload = b.key.startsWith('sf_cache_') ? parsed.accounts : parsed.txns;
      if (typeof parsed.fetchedAt === 'number' && payload !== undefined) {
        insBlob.run(b.key, parsed.fetchedAt, JSON.stringify(payload));
      }
    } catch { /* unreadable blob — drop it; it regenerates on the next fetch */ }
    db.prepare('DELETE FROM meta WHERE key = ?').run(b.key);
  }

  // One-shot data migrations, still guarded by their original meta flags so a
  // database where they already ran doesn't rerun them.
  migrateTaxonomy(db);
  migrateAddPaymentCategory(db);
  migrateKeepImportCategories(db);
  migrateGroupMerges(db);
}

// Remap an existing install from the old flat category scheme to the current
// (Monarch-style) taxonomy: rules and targets are renamed, and the active
// category list is rebuilt (preserving user-added customs). On a brand-new
// database this is what seeds budget_categories with the default taxonomy.
function migrateTaxonomy(db: Db) {
  const existing = (db.prepare('SELECT name FROM budget_categories').all() as { name: string }[]).map(r => r.name);
  const done = db.prepare(`SELECT value FROM meta WHERE key = 'cat_taxonomy_v2'`).get();
  if (done) return;

  for (const [oldC, newC] of Object.entries(TAXONOMY_MIGRATION)) {
    db.prepare('UPDATE OR REPLACE txn_rules SET category = ? WHERE category = ?').run(newC, oldC);
    db.prepare('UPDATE OR REPLACE txn_base_rules SET category = ? WHERE category = ?').run(newC, oldC);
    db.prepare('UPDATE OR REPLACE budget_targets SET category = ? WHERE category = ?').run(newC, oldC);
  }

  const oldScheme = new Set([...Object.keys(TAXONOMY_MIGRATION), 'Groceries', 'Shopping', 'Subscriptions', 'Transfers', 'Mortgage']);
  const newSet = new Set(CATEGORIES);
  const customs = existing.filter(n => !oldScheme.has(n) && !newSet.has(n));
  db.prepare('DELETE FROM budget_categories').run();
  const ins = db.prepare('INSERT OR IGNORE INTO budget_categories (name, sort) VALUES (?, ?)');
  CATEGORIES.forEach((c, i) => ins.run(c, i));
  customs.forEach((c, i) => ins.run(c, CATEGORIES.length + i));

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('cat_taxonomy_v2', '1')`).run();
}

// One-time: add the Credit Card Payment category (a Transfers-like excluded type)
// to existing installs whose category list predates it. Fresh installs already
// get it from the taxonomy.
function migrateAddPaymentCategory(db: Db) {
  if (db.prepare(`SELECT value FROM meta WHERE key = 'cc_payment_cat_v1'`).get()) return;
  if (!db.prepare('SELECT 1 FROM budget_categories WHERE name = ?').get('Credit Card Payment')) {
    const max = (db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM budget_categories').get() as { m: number }).m;
    db.prepare('INSERT OR IGNORE INTO budget_categories (name, sort, emoji) VALUES (?, ?, ?)').run('Credit Card Payment', max + 1, '💳');
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('cc_payment_cat_v1', '1')`).run();
}

// One-time backfill so categories from already-imported data exist too.
function migrateKeepImportCategories(db: Db) {
  if (db.prepare(`SELECT value FROM meta WHERE key = 'import_cats_kept_v1'`).get()) return;
  const raw = (db.prepare(`SELECT DISTINCT category FROM imported_txns WHERE category IS NOT NULL AND TRIM(category) <> ''`).all() as { category: string }[]).map(r => r.category);
  ensureImportedCategories(db, raw);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('import_cats_kept_v1', '1')`).run();
}

function migrateGroupMerges(db: Db) {
  if (db.prepare(`SELECT value FROM meta WHERE key = 'cat_group_merge_v1'`).get()) return;
  for (const [oldG, newG] of Object.entries(GROUP_MERGES)) {
    db.prepare('UPDATE budget_categories SET grp = ? WHERE grp = ?').run(newG, oldG);
  }
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('cat_group_merge_v1', '1')`).run();
}

// The durable transaction store (see services/feedStore.ts). Backfills from
// whatever provider payloads are already cached, so an upgraded database has
// its full cached history in the table immediately — from then on the daily
// sync keeps it current and rows never age out.
function feedTransactionsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id            TEXT PRIMARY KEY,           -- provider txn id (or stable synthetic id)
      account_id    TEXT NOT NULL,
      account_name  TEXT NOT NULL,
      source        TEXT NOT NULL,              -- 'simplefin' | 'plaid'
      posted        INTEGER NOT NULL,           -- unix seconds
      transacted_at INTEGER,                    -- unix seconds, when known
      amount        REAL NOT NULL,              -- + = money in (SimpleFIN convention)
      payee         TEXT NOT NULL DEFAULT '',
      description   TEXT NOT NULL DEFAULT '',
      memo          TEXT NOT NULL DEFAULT '',
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_posted  ON transactions (posted);
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions (account_id, posted);
  `);

  const since = Math.floor(Date.now() / 1000) - FEED_WINDOW_DAYS * 86400;
  const cached = db.prepare(`SELECT key, payload FROM provider_cache`).all() as { key: string; payload: string }[];
  for (const row of cached) {
    try {
      if (row.key.startsWith('sf_cache_')) {
        syncFeedTransactions(db, 'simplefin', rawTxnsFromSimpleFin(JSON.parse(row.payload) as SimpleFinFeedAccount[]), since);
      } else if (row.key.startsWith('plaid_txn_cache_')) {
        syncFeedTransactions(db, 'plaid', JSON.parse(row.payload) as RawTxn[], since);
      }
    } catch { /* unreadable payload — the next provider fetch repopulates */ }
  }
}

// Collapse the five rule tables (txn_rules, txn_base_rules, txn_sign_rules,
// txn_sign_base_rules, txn_smart_rules) into one `rules` table with a `kind`
// discriminator. Matching semantics and precedence (exact merchant > smart >
// base; sign rules independent) are unchanged — this is purely storage.
function unifiedRulesTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,   -- 'merchant' | 'base' | 'smart' | 'sign' | 'sign_base'
      merchant   TEXT,            -- exact merchant key (kind = merchant | sign)
      base       TEXT,            -- normalised merchant base (kind = base | sign_base | smart condition)
      contains   TEXT,            -- smart: lowercased substring of payee+description
      amount     REAL,            -- smart: exact absolute amount
      category   TEXT,            -- target category; NULL for sign kinds
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One rule per merchant/base per kind (mirrors the old tables' primary keys);
    -- smart rules may repeat, hence the kind-scoped partial indexes.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_rules_kind_merchant ON rules (kind, merchant) WHERE merchant IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_rules_kind_base ON rules (kind, base) WHERE base IS NOT NULL AND kind != 'smart';

    INSERT INTO rules (kind, merchant, category) SELECT 'merchant', merchant, category FROM txn_rules;
    INSERT INTO rules (kind, base, category)     SELECT 'base', base, category FROM txn_base_rules;
    INSERT INTO rules (kind, merchant)           SELECT 'sign', merchant FROM txn_sign_rules;
    INSERT INTO rules (kind, base)               SELECT 'sign_base', base FROM txn_sign_base_rules;
    INSERT INTO rules (kind, base, contains, amount, category, created_at)
      SELECT 'smart', base, contains, amount, category, created_at FROM txn_smart_rules ORDER BY id;

    DROP TABLE txn_rules;
    DROP TABLE txn_base_rules;
    DROP TABLE txn_sign_rules;
    DROP TABLE txn_sign_base_rules;
    DROP TABLE txn_smart_rules;
  `);
}

// Append-only per-asset balance history (see services/observations.ts).
// Written from every sync and daily snapshot; the backfill fills earlier dates
// with estimated rows that never overwrite real ones.
function balanceObservationsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_observations (
      account_id TEXT NOT NULL,  -- accounts.id | 'property:<id>' (equity) | 'manual:<id>'
      date       TEXT NOT NULL,
      balance    REAL NOT NULL,
      estimated  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_balance_obs_date ON balance_observations (date);
  `);
}

// Marks imported rows the user recategorized by hand, so that explicit choice
// can outrank merchant-level rules at read time.
function importedCatEdited(db: Db) {
  addColumn(db, `ALTER TABLE imported_txns ADD COLUMN cat_edited INTEGER NOT NULL DEFAULT 0`);
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', up: baseline },
  { version: 2, name: 'feed-transactions-table', up: feedTransactionsTable },
  { version: 3, name: 'unified-rules-table', up: unifiedRulesTable },
  { version: 4, name: 'balance-observations-table', up: balanceObservationsTable },
  { version: 5, name: 'imported-cat-edited', up: importedCatEdited },
];

// Apply every migration newer than the database's user_version, each in its own
// transaction so a failure leaves the database at the last good version.
export function runMigrations(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    console.log(`[db] applied migration ${m.version} (${m.name})`);
  }
}
