import { existsSync, readdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { getNetWorthHistory, getCurrentBreakdown, getTaxBuckets } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getBudget, getTransactionsList, getSpendingProjection } from './budget.js';

// Compare two dotted version strings numerically (e.g. "2.1.181" vs "2.1.20").
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Locate the Claude Code binary so the assistant can run on the user's existing
// login (subscription) instead of a paid API key. Resolution order:
//   1. CLAUDE_BIN env override
//   2. a `claude` on PATH (standalone CLI install)
//   3. the binary bundled inside the macOS desktop app (newest version)
let cachedBin: string | null | undefined;
export function findClaudeBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  cachedBin = resolveClaudeBinary();
  return cachedBin;
}

function resolveClaudeBinary(): string | null {
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  try {
    const onPath = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    if (onPath) return onPath;
  } catch { /* not on PATH */ }

  // macOS desktop app: ~/Library/Application Support/Claude/claude-code/<version>/claude.app/...
  const base = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');
  try {
    const versions = readdirSync(base).filter(v => /^\d+\./.test(v)).sort((a, b) => cmpVersion(b, a));
    for (const v of versions) {
      const bin = path.join(base, v, 'claude.app/Contents/MacOS/claude');
      if (existsSync(bin)) return bin;
    }
  } catch { /* not installed here */ }

  return null;
}

// --- Login status ----------------------------------------------------------
// Whether the resolved Claude binary is logged in, as established by REAL chat /
// ingest calls (markLoggedIn/markLoggedOut). We deliberately do NOT run a
// speculative "are you logged in?" query: there's no cheap, reliable way to
// confirm a *successful* login without running (and paying for) a real turn, and
// a short-timeout probe gives false positives on a cold binary start. So the
// status is `null` (unknown) until the first real call settles it; the UI then
// proceeds optimistically and shows the login gate the moment a call reports
// it's not logged in.
let loggedInCache: boolean | null = null;
export function markLoggedIn() { loggedInCache = true; }
export function markLoggedOut() { loggedInCache = false; }
// Forget the known state (e.g. the user says they just logged in) so the UI
// proceeds optimistically and the next real call re-establishes the truth.
export function resetAuthStatus() { loggedInCache = null; }

export interface AuthStatus { binaryFound: boolean; loggedIn: boolean | null; command?: string }

// Report what we currently know about login, so the UI can show the gate up
// front once a prior call has established the binary isn't logged in.
export function getAuthStatus(): AuthStatus {
  const bin = findClaudeBinary();
  if (!bin) return { binaryFound: false, loggedIn: null };
  return { binaryFound: true, loggedIn: loggedInCache, command: loggedInCache === false ? `"${bin}"` : undefined };
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString();

interface Snapshot { date: string; accounts_total: number; real_estate_total: number; net_worth: number }

// Assemble a compact, current snapshot of the user's finances for the model to
// reason over. Each section is best-effort — a failure in one (e.g. a live
// holdings fetch for allocation) must not blank out the rest of the context.
export async function buildFinancialContext(): Promise<string> {
  const parts: string[] = [];

  try {
    const history = getNetWorthHistory(10000) as Snapshot[];
    const latest = history[history.length - 1];
    if (latest) {
      parts.push(
        `## Net worth (as of ${latest.date})\n` +
        `- Net worth: ${money(latest.net_worth)}\n` +
        `- Accounts & assets: ${money(latest.accounts_total)}\n` +
        `- Real estate (equity): ${money(latest.real_estate_total)}`,
      );
      // A handful of historical anchors so the model can speak to the trend.
      const anchors = [365, 180, 90, 30]
        .map(days => {
          const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
          const pt = history.find(s => s.date >= cutoff);
          return pt ? `  - ${pt.date}: ${money(pt.net_worth)}` : null;
        })
        .filter(Boolean);
      if (anchors.length) parts.push(`## Net worth history\n${anchors.join('\n')}`);
    }
  } catch (e) { console.error('[assistant] net worth context failed:', e); }

  try {
    const { accounts, manualAssets, properties } = getCurrentBreakdown() as {
      accounts: { name: string; org_name: string; category: string; balance: number; hidden: number }[];
      manualAssets: { name: string; category: string; value: number }[];
      properties: { address: string; zestimate: number | null; mortgage_balance: number }[];
    };
    const visible = accounts.filter(a => !a.hidden);
    if (visible.length) {
      const lines = visible.map(a => `  - ${a.name} (${a.org_name}, ${a.category}): ${money(a.balance)}`);
      parts.push(`## Connected accounts\n${lines.join('\n')}`);
    }
    if (manualAssets.length) {
      const lines = manualAssets.map(a => `  - ${a.name} (${a.category}): ${money(a.value)}`);
      parts.push(`## Manual assets\n${lines.join('\n')}`);
    }
    if (properties.length) {
      const lines = properties.map(p => {
        const equity = (p.zestimate ?? 0) - (p.mortgage_balance ?? 0);
        return `  - ${p.address}: value ${money(p.zestimate)}, mortgage ${money(p.mortgage_balance)}, equity ${money(equity)}`;
      });
      parts.push(`## Real estate\n${lines.join('\n')}`);
    }
  } catch (e) { console.error('[assistant] breakdown context failed:', e); }

  try {
    const alloc = await getAllocation();
    if (alloc.total > 0) {
      const classes = alloc.byAssetClass.map(s => `  - ${s.name}: ${s.pct.toFixed(1)}% (${money(s.value)})`);
      const top = alloc.byStock.slice(0, 10).map(s => `  - ${s.symbol} ${s.name}: ${s.pct.toFixed(1)}% (${money(s.value)})`);
      parts.push(
        `## Investment allocation (total ${money(alloc.total)})\n` +
        `By asset class:\n${classes.join('\n')}\n` +
        `Top holdings:\n${top.join('\n')}`,
      );
    }
  } catch (e) { console.error('[assistant] allocation context failed:', e); }

  try {
    const budget = await getBudget();
    const cats = budget.byCategory
      .filter(c => c.spent > 0 || c.target > 0)
      .map(c => `  - ${c.category}: spent ${money(c.spent)}${c.target ? ` of ${money(c.target)} target` : ''}`);
    parts.push(
      `## Budget (${budget.month})\n` +
      `- Income: ${money(budget.income)}\n` +
      `- Spending: ${money(budget.spending)}\n` +
      `- Total budget target: ${money(budget.totalBudget)}\n` +
      (cats.length ? `By category:\n${cats.join('\n')}` : ''),
    );
  } catch (e) { console.error('[assistant] budget context failed:', e); }

  return parts.join('\n\n');
}

// Dump the user's full data to files in `dir` so the assistant can open them with
// the Read tool on demand — giving it access to detail the static snapshot omits
// (every transaction, all holdings, full history) without bloating the prompt.
// Best-effort per file; returns a markdown list of the files that were written
// (for the system prompt), or '' if none. The caller deletes `dir` after the turn.
export async function exportChatData(dir: string, clientForecast?: unknown): Promise<string> {
  const files: { name: string; desc: string }[] = [];
  const writeJson = (name: string, data: unknown, desc: string) => {
    try { writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), { mode: 0o600 }); files.push({ name, desc }); }
    catch (e) { console.error(`[assistant] export ${name} failed:`, e); }
  };
  // Newline-delimited JSON (one record per line) for the potentially-large files,
  // so the Read tool (which pages by line) can scan and offset through them.
  const writeJsonl = (name: string, rows: unknown[], desc: string) => {
    try { writeFileSync(path.join(dir, name), rows.map(r => JSON.stringify(r)).join('\n'), { mode: 0o600 }); files.push({ name, desc }); }
    catch (e) { console.error(`[assistant] export ${name} failed:`, e); }
  };

  try {
    const { transactions } = await getTransactionsList('all');
    writeJsonl('transactions.jsonl', transactions,
      `Every transaction, one JSON object per line, newest first (${transactions.length} rows). ` +
      `Fields: date (YYYY-MM-DD), amount (negative = money out/spending, positive = money in/income), ` +
      `payee, merchant, account, category, memo.`);
  } catch (e) { console.error('[assistant] export transactions failed:', e); }

  try {
    writeJson('accounts.json', getCurrentBreakdown(),
      'All accounts (including hidden), manual assets, and properties, with balances and categories.');
  } catch (e) { console.error('[assistant] export accounts failed:', e); }

  try {
    const a = await getAllocation();
    // Trim the full fund look-through (thousands of underlying stocks) to keep the
    // file small: the user's actual positions, the class/sector/country slices, and
    // the top stock exposures are what a question would need.
    writeJson('allocation.json', {
      total: a.total,
      byAssetClass: a.byAssetClass,
      bySector: a.bySector,
      byCountry: a.byCountry,
      holdings: a.holdings.map(h => ({ symbol: h.symbol, name: h.name, value: h.value, costBasis: h.costBasis, pct: h.pct, assetClass: h.assetClass })),
      topStockExposures: a.byStock.slice(0, 50).map(s => ({ symbol: s.symbol, name: s.name, value: s.value, pct: s.pct })),
    }, 'Investment allocation: your positions (holdings), breakdowns by asset class / sector / country, and your top 50 underlying stock exposures (look-through).');
  } catch (e) { console.error('[assistant] export allocation failed:', e); }

  try {
    writeJsonl('net_worth_history.jsonl', getNetWorthHistory(10000) as unknown[],
      'Daily net-worth snapshots over time, one JSON object per line: date, accounts_total, real_estate_total, net_worth.');
  } catch (e) { console.error('[assistant] export history failed:', e); }

  try {
    const b = await getBudget();
    // Drop the per-month transaction arrays (already in transactions.jsonl) — keep
    // the summary figures and per-category targets/spend.
    writeJson('budget.json', {
      month: b.month, months: b.months,
      income: b.income, spending: b.spending, mortgage: b.mortgage, totalBudget: b.totalBudget,
      byCategory: b.byCategory, comparison: b.comparison,
    }, 'Current-month budget summary: income, spending, mortgage, and per-category target vs. spent (with YTD where set).');
  } catch (e) { console.error('[assistant] export budget failed:', e); }

  // Forecasting / retirement-planning data. The Monte Carlo lives in the browser,
  // so the plan inputs + computed summary arrive from the client (clientForecast).
  // We add the server-derived spending trend and tax-treatment balances, which the
  // forecast is built on, so planning questions have the full picture.
  try {
    const forecast: Record<string, unknown> = {};
    if (clientForecast && typeof clientForecast === 'object') forecast.plan = clientForecast;
    try { forecast.spendingTrend = await getSpendingProjection(); } catch (e) { console.error('[assistant] projection failed:', e); }
    try { forecast.taxBuckets = getTaxBuckets(); } catch (e) { console.error('[assistant] tax buckets failed:', e); }
    if (Object.keys(forecast).length) {
      writeJson('forecast.json', forecast,
        'Retirement/financial-planning data. `plan` = the user\'s Forecast inputs (assumptions: ' +
        'returns, inflation, spending, tax rates; earners: income, retirement ages, contributions; ' +
        'life events; kids) and the computed projection summary (current net worth, median net worth ' +
        'at the plan-to age, 80% range, and success probability from the Monte Carlo). `spendingTrend` ' +
        '= trailing average spending/income and annualized trend from transactions. `taxBuckets` = ' +
        'balances by tax treatment (taxable, pre-tax, Roth, HSA, 529).');
    }
  } catch (e) { console.error('[assistant] export forecast failed:', e); }

  if (!files.length) return '';
  return (
    'These files are in your current working directory. Use the Read tool to open ' +
    'whichever you need when the question calls for detail beyond the snapshot above ' +
    '(e.g. a specific merchant, date range, or individual transactions). The `.jsonl` ' +
    'files have one JSON record per line and can be large — page through them with ' +
    'Read offsets if needed.\n' +
    files.map(f => `- ${f.name} — ${f.desc}`).join('\n')
  );
}

export function systemPrompt(context: string, dataFiles = ''): string {
  return (
    `You are the built-in financial assistant for KevFin, a personal net-worth ` +
    `tracker. The user is the owner of this data and is asking about their own ` +
    `finances. Answer their questions using the live snapshot of their accounts, ` +
    `investments, real estate, and budget provided below.\n\n` +
    `Guidelines:\n` +
    `- Be concise and direct. Lead with the answer, then any supporting detail.\n` +
    `- Use the figures from the snapshot; format money clearly (e.g. $1,234).\n` +
    `- The snapshot is aggregated. For detail it doesn't contain — individual ` +
    `transactions, a specific merchant or date, every holding — Read the relevant ` +
    `data file listed under "Detailed data files" before answering, rather than ` +
    `saying you don't have it.\n` +
    `- Don't fabricate numbers. If the answer truly isn't in the snapshot or the ` +
    `files, say so plainly.\n` +
    `- You can offer observations and general financial education, but make clear ` +
    `you are not a licensed financial advisor and avoid specific buy/sell advice.\n\n` +
    `# Current financial snapshot\n\n${context || '(No financial data available yet.)'}` +
    (dataFiles ? `\n\n# Detailed data files\n\n${dataFiles}` : '')
  );
}
