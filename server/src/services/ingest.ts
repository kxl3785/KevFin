import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { findClaudeBinary, markLoggedIn, markLoggedOut } from './assistant.js';
import { takeSnapshot } from './netWorth.js';
import { CATEGORIES, type Category } from '../util/categorize.js';
import { getDb } from '../db/schema.js';

// --- Proposal shapes -------------------------------------------------------
// One "proposal" is a single row the model wants to add to one of KevFin's four
// entry tables. The model returns these from a document; the user reviews and
// confirms them before anything is written (see commitProposals).
export type Proposal =
  | { table: 'manual_assets'; summary: string; confidence: number;
      fields: { name: string; category: Category; value: number } }
  | { table: 'imported_txns'; summary: string; confidence: number;
      fields: { date: string; amount: number; payee: string; merchant: string; account: string; category: string } }
  | { table: 'properties'; summary: string; confidence: number;
      fields: { address: string; value: number | null; mortgage_balance: number } }
  | { table: 'accounts'; summary: string; confidence: number;
      fields: { org_name: string; name: string; category: Category; balance: number } }
  // A security's total cost basis from a 1099-B / brokerage positions statement.
  // Keyed (on commit) by symbol, falling back to name — matches a holding's id in
  // the allocation view, where it fills in a missing/wrong basis.
  | { table: 'cost_basis'; summary: string; confidence: number;
      fields: { symbol: string; name: string; costBasis: number } }
  // Planning inputs (e.g. from a tax return) that populate the Forecast page
  // rather than a database table. Applied client-side, never inserted here.
  | { table: 'forecast'; summary: string; confidence: number;
      fields: {
        annualIncome: number | null;   // taxpayer's wages / total income
        spouseIncome: number | null;   // spouse's wages on a joint return
        effTaxRate: number | null;     // percent 0–100
        filingStatus: FilingStatus | null;
        dependents: number | null;     // qualifying children under 17 (CTC)
      } };

export type FilingStatus = 'single' | 'married' | 'head_of_household' | 'other';
const FILING_STATUSES = new Set<FilingStatus>(['single', 'married', 'head_of_household', 'other']);

export interface ExtractResult {
  docType: string;
  notes: string;
  proposals: Proposal[];
}

// Raised when extraction can't run/parse. `usageLimited` lets the route map it
// to a 429 (the user's Claude plan limit was reached), matching the chat route.
// `command` is an optional terminal command the UI can show with a Copy button —
// e.g. the exact binary to run `/login` on when auth is the problem.
export class IngestError extends Error {
  constructor(message: string, readonly usageLimited = false, readonly command?: string) { super(message); }
}

// Build a clear "not logged in" error tied to the EXACT binary the server uses,
// so the user logs in the right Claude when several installs exist. Running the
// binary with no args drops into its TUI, where `/login` is available.
export function notLoggedInError(bin: string): IngestError {
  return new IngestError(
    'Claude Code isn’t logged in. Open a terminal, run the command below, then type /login and pick your subscription — this is the exact Claude the importer uses. Then try again.',
    false,
    `"${bin}"`,
  );
}

const TABLES = new Set(['manual_assets', 'imported_txns', 'properties', 'accounts', 'cost_basis', 'forecast']);
const MAX_BYTES = 12 * 1024 * 1024; // decoded; stays under express' 15mb JSON cap once base64-inflated

// Only formats Claude Code's Read tool can actually interpret. Anything else
// would just be read as bytes and waste a query.
const ALLOWED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.csv', '.txt', '.md', '.json']);

const EXTRACT_SYSTEM =
  'You are a financial-document extraction engine for KevFin, a personal ' +
  'net-worth tracker and retirement forecaster. You read ONE uploaded document ' +
  'and propose entries that capture its financially-relevant contents — account ' +
  'balances, transactions, property, or (for a tax return) retirement-planning ' +
  'inputs. The document belongs to the user (their own finances). Output ONLY a ' +
  'single JSON object — no prose, no markdown code fences.';

function extractPrompt(fileName: string): string {
  return (
`Read the file ./${fileName} in the current working directory and extract entries.

Return a JSON object exactly matching this TypeScript type:
{
  "docType": string,   // e.g. "brokerage statement", "receipt", "pay stub", "mortgage statement"
  "notes": string,     // one short caveat, or "" if none
  "proposals": Array<
    | { "table": "manual_assets", "summary": string, "confidence": number,
        "fields": { "name": string, "category": "banking"|"brokerage"|"credit"|"other", "value": number } }
    | { "table": "imported_txns", "summary": string, "confidence": number,
        "fields": { "date": "YYYY-MM-DD", "amount": number, "payee": string, "merchant": string, "account": string, "category": string } }
    | { "table": "properties", "summary": string, "confidence": number,
        "fields": { "address": string, "value": number|null, "mortgage_balance": number } }
    | { "table": "accounts", "summary": string, "confidence": number,
        "fields": { "org_name": string, "name": string, "category": "banking"|"brokerage"|"credit"|"other", "balance": number } }
    | { "table": "cost_basis", "summary": string, "confidence": number,
        "fields": { "symbol": string, "name": string, "costBasis": number } }
    | { "table": "forecast", "summary": string, "confidence": number,
        "fields": { "annualIncome": number|null, "spouseIncome": number|null, "effTaxRate": number|null,
                    "filingStatus": "single"|"married"|"head_of_household"|"other"|null, "dependents": number|null } }
  >
}

Pick the table that best fits the document:
- An end-of-period balance for an investment or bank account → "manual_assets" (preferred for a single balance) or "accounts".
- Individual purchases/payments (e.g. a receipt or a transaction list) → one "imported_txns" entry per transaction.
- A home value or mortgage statement → "properties".
- A tax return (Form 1040), a W-2, or a year-end tax summary → a SINGLE "forecast" entry capturing retirement-planning inputs (see below). Do not also emit transactions for it.
- A 1099-B, a realized-gains report, or a brokerage POSITIONS/holdings statement that lists cost basis per security → one "cost_basis" entry per security. Use these for the per-security TOTAL cost basis; do NOT also emit "manual_assets"/"accounts" balances for the same securities.

Rules:
- cost_basis.symbol: the ticker (e.g. "AAPL", "VOO"); "" if the document only gives a name. cost_basis.name: the security's description. cost_basis.costBasis: total cost basis (what was paid) for the whole position, a positive number. Skip a security if no cost basis is shown.
- forecast.annualIncome: the primary taxpayer's gross annual wages (their W-2 box 1). If individual wages aren't separable, use the 1040 total income / AGI. null if not present.
- forecast.spouseIncome: on a joint return, the SPOUSE's wages (their separate W-2 box 1). null if single or not separable.
- forecast.effTaxRate: the effective tax rate as a PERCENT 0–100, computed as total tax ÷ total income (e.g. 18.5). null if it can't be derived.
- forecast.filingStatus: the 1040 filing status — "married" for married-filing-jointly/separately, else "single", "head_of_household", or "other". null if unknown.
- forecast.dependents: the number of qualifying CHILDREN under 17 (those claimed for the Child Tax Credit). Do NOT count other dependents (e.g. parents). null if none/unknown.
- imported_txns.amount: POSITIVE for money in (income, deposits, refunds), NEGATIVE for money out (purchases, payments).
- All numbers are plain (no currency symbols, no thousands separators). Dates are YYYY-MM-DD.
- "confidence" is 0..1, how sure you are of the extracted values.
- If the document contains no financial data you can turn into an entry, return "proposals": [].
- Output ONLY the JSON object, nothing else.`
  );
}

// Pull the first balanced JSON object out of the model's reply, tolerating
// stray prose or ```json fences around it.
function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new IngestError('The assistant did not return a readable result for that document.');
  }
  return JSON.parse(body.slice(start, end + 1));
}

function looksUsageLimited(s: string): boolean {
  return /usage limit|rate limit|limit reached|too many requests/i.test(s);
}

// Run the local Claude Code binary over the document and return parsed proposals.
// The file lives in a private temp dir for the duration of the query only and is
// deleted in the finally — nothing about the document is retained on disk.
export async function extractFromDocument(input: {
  filename: string;
  dataBase64: string;
}): Promise<ExtractResult> {
  const bin = findClaudeBinary();
  if (!bin) {
    throw new IngestError('Claude Code was not found on this machine. Install it (or set CLAUDE_BIN in server/.env) to use document upload.');
  }

  const ext = path.extname(input.filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new IngestError(`Unsupported file type "${ext || 'unknown'}". Upload a PDF, image, CSV, or text document.`);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.dataBase64, 'base64');
  } catch {
    throw new IngestError('The uploaded file could not be decoded.');
  }
  if (!bytes.length) throw new IngestError('The uploaded file was empty.');
  if (bytes.length > MAX_BYTES) throw new IngestError('That file is too large (max 12 MB).');

  // A fresh temp dir per upload; the file keeps a safe, fixed name + its real
  // extension so the model reads it correctly and can't be tricked by the
  // original filename. cwd is this dir, so `Read` only ever sees this one file.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kevfin-ingest-'));
  const safeName = `document${ext}`;
  const filePath = path.join(dir, safeName);

  try {
    writeFileSync(filePath, bytes, { mode: 0o600 });

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, [
        '-p', extractPrompt(safeName),
        '--model', 'claude-opus-4-8',
        '--system-prompt', EXTRACT_SYSTEM,
        '--allowedTools', 'Read',   // read the one file; no writes, no network
        '--output-format', 'json',
      ], { cwd: dir, env: process.env });

      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('error', () => reject(new IngestError('Could not start Claude Code.')));
      child.on('close', () => resolve(out));
    });

    let result = '';
    let isError = true;
    try {
      const obj = JSON.parse(stdout.trim());
      result = typeof obj.result === 'string' ? obj.result : '';
      isError = !!obj.is_error;
    } catch {
      throw new IngestError('Could not read the document — the assistant returned no result.');
    }

    if (isError) {
      if (looksUsageLimited(result)) {
        throw new IngestError("You've reached your Claude plan's usage limit. Try again later.", true);
      }
      if (/not logged in|\/login/i.test(result)) {
        markLoggedOut();
        throw notLoggedInError(bin);
      }
      throw new IngestError(result || 'The document could not be processed.');
    }

    markLoggedIn(); // a clean extraction proves we're authenticated
    return normalizeResult(parseJsonObject(result));
  } finally {
    // Wipe the document and its temp dir no matter what — success, extraction
    // error, parse failure, or usage-limit. The file existed only in this private
    // temp dir for the single Read-only query; nothing about it is kept on disk.
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Validation ------------------------------------------------------------
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const cat = (v: unknown): Category => (CATEGORIES.includes(v as Category) ? (v as Category) : 'other');
const clamp01 = (v: unknown): number => { const n = num(v); return n == null ? 0.5 : Math.min(1, Math.max(0, n)); };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Coerce the model's loose JSON into well-formed Proposals, dropping anything
// that's missing the fields its table needs. Defensive: the model output is
// never trusted directly against the database.
function normalizeResult(raw: unknown): ExtractResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.proposals) ? o.proposals : [];
  const proposals: Proposal[] = [];

  for (const item of list) {
    const p = (item ?? {}) as Record<string, unknown>;
    const f = (p.fields ?? {}) as Record<string, unknown>;
    const summary = str(p.summary);
    const confidence = clamp01(p.confidence);
    if (!TABLES.has(p.table as string)) continue;

    if (p.table === 'manual_assets') {
      const value = num(f.value);
      const name = str(f.name);
      if (!name || value == null) continue;
      proposals.push({ table: 'manual_assets', summary, confidence, fields: { name, category: cat(f.category), value } });
    } else if (p.table === 'imported_txns') {
      const amount = num(f.amount);
      const date = str(f.date);
      const payee = str(f.payee) || str(f.merchant);
      if (amount == null || !ISO_DATE.test(date) || !payee) continue;
      proposals.push({
        table: 'imported_txns', summary, confidence,
        fields: { date, amount, payee, merchant: str(f.merchant) || payee, account: str(f.account) || 'Uploaded document', category: str(f.category) || 'Miscellaneous' },
      });
    } else if (p.table === 'properties') {
      const address = str(f.address);
      if (!address) continue;
      proposals.push({ table: 'properties', summary, confidence, fields: { address, value: num(f.value), mortgage_balance: num(f.mortgage_balance) ?? 0 } });
    } else if (p.table === 'accounts') {
      const balance = num(f.balance);
      const name = str(f.name);
      if (!name || balance == null) continue;
      proposals.push({ table: 'accounts', summary, confidence, fields: { org_name: str(f.org_name) || 'Manual', name, category: cat(f.category), balance } });
    } else if (p.table === 'cost_basis') {
      const costBasis = num(f.costBasis);
      const symbol = str(f.symbol).toUpperCase();
      const name = str(f.name);
      // Needs a positive basis and something to key on (symbol or name).
      if (costBasis == null || costBasis <= 0 || (!symbol && !name)) continue;
      proposals.push({ table: 'cost_basis', summary, confidence, fields: { symbol, name, costBasis } });
    } else if (p.table === 'forecast') {
      const annualIncome = num(f.annualIncome);
      const spouseIncome = num(f.spouseIncome);
      const effRaw = num(f.effTaxRate);
      const effTaxRate = effRaw == null ? null : Math.min(100, Math.max(0, effRaw));
      const depRaw = num(f.dependents);
      const dependents = depRaw == null ? null : Math.max(0, Math.round(depRaw));
      const fs = str(f.filingStatus).toLowerCase().replace(/[\s-]+/g, '_');
      const filingStatus = FILING_STATUSES.has(fs as FilingStatus) ? (fs as FilingStatus) : null;
      // Drop a forecast entry only if it carries nothing usable at all.
      if (annualIncome == null && spouseIncome == null && effTaxRate == null && filingStatus == null && dependents == null) continue;
      proposals.push({ table: 'forecast', summary, confidence, fields: { annualIncome, spouseIncome, effTaxRate, filingStatus, dependents } });
    }
  }

  return { docType: str(o.docType) || 'document', notes: str(o.notes), proposals };
}

// --- Commit ----------------------------------------------------------------
export interface CommitResult { inserted: number; byTable: Record<string, number> }

// Insert the user-confirmed proposals into their tables, then re-snapshot net
// worth once. Reuses the same shapes the manual REST routes write.
export function commitProposals(rawProposals: unknown): CommitResult {
  // Run the same validation as extraction so hand-edited fields can't write junk.
  const { proposals } = normalizeResult({ proposals: rawProposals });
  if (!proposals.length) throw new IngestError('There were no valid entries to add.');

  const db = getDb();
  const byTable: Record<string, number> = {};

  const insertAsset = db.prepare('INSERT INTO manual_assets (name, category, value) VALUES (?, ?, ?)');
  const insertTxn = db.prepare('INSERT INTO imported_txns (id, date, amount, payee, merchant, account, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertProperty = db.prepare(`INSERT INTO properties (address, zestimate, mortgage_balance) VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET zestimate = COALESCE(excluded.zestimate, properties.zestimate), mortgage_balance = excluded.mortgage_balance, updated_at = datetime('now')`);
  const insertAccount = db.prepare(`INSERT INTO accounts (id, source, org_name, name, currency, balance, category, balance_date)
    VALUES (?, 'manual', ?, ?, 'USD', ?, ?, date('now'))`);
  const insertBasis = db.prepare(`INSERT INTO imported_cost_basis (symbol, cost_basis) VALUES (?, ?)
    ON CONFLICT(symbol) DO UPDATE SET cost_basis = excluded.cost_basis, updated_at = datetime('now')`);

  const run = db.transaction((items: Proposal[]) => {
    for (const p of items) {
      // Forecast inputs live in the client's Forecast settings, not the database.
      // The client applies them locally and shouldn't post them here, but guard
      // anyway so a stray one is ignored rather than mis-inserted.
      if (p.table === 'forecast') continue;
      if (p.table === 'manual_assets') {
        insertAsset.run(p.fields.name, p.fields.category, p.fields.value);
      } else if (p.table === 'imported_txns') {
        insertTxn.run(`doc-${randomUUID()}`, p.fields.date, p.fields.amount, p.fields.payee, p.fields.merchant, p.fields.account, p.fields.category);
      } else if (p.table === 'properties') {
        insertProperty.run(p.fields.address, p.fields.value, p.fields.mortgage_balance);
      } else if (p.table === 'cost_basis') {
        // Key by symbol (matches a tickered holding); fall back to name.
        insertBasis.run(p.fields.symbol || p.fields.name, p.fields.costBasis);
      } else {
        insertAccount.run(`manual-${randomUUID()}`, p.fields.org_name, p.fields.name, p.fields.balance, p.fields.category);
      }
      byTable[p.table] = (byTable[p.table] ?? 0) + 1;
    }
  });
  run(proposals);

  takeSnapshot(); // reflect the new entries in net worth immediately
  return { inserted: proposals.length, byTable };
}
