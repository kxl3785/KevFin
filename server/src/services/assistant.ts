import { existsSync, readdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { getNetWorthHistory, getCurrentBreakdown, getTaxBuckets } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getBudget, getTransactionsList, getSpendingProjection } from './budget.js';
import { CHART_FENCE, CHART_FORMATS, CHART_LIMITS, CHART_TYPES } from '../shared/chartSpec.js';
import { ACTION_FENCE, ACCOUNT_CATEGORIES, FORECAST_FIELDS } from '../shared/assistantAction.js';
import { getActiveCategories, getCategoryLabeler } from './categories.js';
import { getStoredReport } from './reportCache.js';
import { reportHtmlToText } from '../util/reportText.js';

// The stored quarterly report as text, when the user has the report open.
export const REPORT_FILE = 'quarterly_report.txt';

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

// --- Sandboxing the spawned binary ------------------------------------------
// Every spawn of the claude binary (chat, document ingest, quarterly report) runs
// with cwd set to a private temp dir holding only the files it should see, and
// untrusted text (transaction memos, uploaded PDFs) can reach the model — so the
// binary is confined to at most one capability: reading files under that cwd.
//  - --tools Read: Read is the only built-in tool that exists at all.
//  - --allowedTools Read(./**): auto-allow reads only inside the cwd (a bare
//    `Read` would permit ~/.ssh, server/.env, ... — there's nobody to prompt in -p).
//  - --disallowedTools: deny rules beat any allow rule in the user's own Claude
//    settings, so shell/write/network tools stay off even if those allow them.
//  - --strict-mcp-config: ignore the user's configured MCP servers.
// The prompt is NOT passed as an argument (variadic flags above would swallow it,
// and a prompt starting with "-" would parse as a flag); callers pipe it to stdin,
// which `-p` reads when no prompt argument is given. Callers must also realpath
// their temp cwd (macOS tmpdir is a /var -> /private/var symlink).
const DENIED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Glob', 'Grep'];
export const SANDBOXED_CLAUDE_ARGS = [
  '--tools', 'Read',
  '--allowedTools', 'Read(./**)',
  '--disallowedTools', ...DENIED_TOOLS,
  '--strict-mcp-config',
];

// For a spawn that is handed everything it needs in the prompt (the quarterly
// report): no tools at all, not even Read.
export const NO_TOOLS_CLAUDE_ARGS = [
  '--tools', '',
  '--disallowedTools', ...DENIED_TOOLS, 'Read',
  '--strict-mcp-config',
];

// The model every spawn (chat, document ingest, quarterly report) runs on.
export const CLAUDE_MODEL = 'claude-opus-5-5';

// The oldest Claude Code release that can run CLAUDE_MODEL. An older binary fails
// every spawn with "does not support this model", so the two builds that bundle
// their own binary — the Docker image (Dockerfile: CLAUDE_CODE_VERSION) and the
// desktop app (desktop/scripts/stage.js: CLAUDE_VERSION) — must pin at least this.
// When you change CLAUDE_MODEL, raise this and both pins together; a test
// (bundledClaudeVersion.test.ts) fails if a pin falls behind.
export const MIN_CLAUDE_CODE_VERSION = '2.1.280';

// Hard ceiling on one claude run, so a hung binary can't pile up (and keep
// billing the subscription) forever.
export const CLAUDE_TIMEOUT_MS = 5 * 60_000;

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
    // getNetWorthHistory returns rows newest-first.
    const history = getNetWorthHistory(10000) as Snapshot[];
    const latest = history[0];
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
          // Oldest snapshot at/after the cutoff — the array is newest-first,
          // so scan from the end.
          let pt: Snapshot | undefined;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].date >= cutoff) { pt = history[i]; break; }
          }
          return pt ? `  - ${pt.date}: ${money(pt.net_worth)}` : null;
        })
        .filter(Boolean);
      if (anchors.length) parts.push(`## Net worth history\n${anchors.join('\n')}`);
    }
  } catch (e) { console.error('[assistant] net worth context failed:', e); }

  try {
    const { accounts, manualAssets, properties } = getCurrentBreakdown();
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
      // pct is a 0..1 fraction (see allocation.ts) — scale for display.
      const classes = alloc.byAssetClass.map(s => `  - ${s.name}: ${(s.pct * 100).toFixed(1)}% (${money(s.value)})`);
      const top = alloc.byStock.slice(0, 10).map(s => `  - ${s.symbol} ${s.name}: ${(s.pct * 100).toFixed(1)}% (${money(s.value)})`);
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

// Write the report the user is looking at into `dir` as text, and describe it for
// the system prompt. The STORED copy only — never regenerated here (that is a
// ~90 s job the user starts themselves) — so the assistant quotes the same
// figures the page shows. Returns null when no report has been generated yet.
export function writeReportFile(dir: string): { name: string; desc: string } | null {
  const stored = getStoredReport();
  const text = stored ? reportHtmlToText(stored.html) : '';
  if (!stored || !text) return null;
  writeFileSync(path.join(dir, REPORT_FILE), text, { mode: 0o600 });
  return {
    name: REPORT_FILE,
    desc: `The ${stored.quarterLabel} quarterly report the user has open, as plain text ` +
      `(generated ${stored.generatedAt.slice(0, 10)}). Charts appear as "[Chart: …]" lines listing their values.`,
  };
}

// Dump the user's full data to files in `dir` so the assistant can open them with
// the Read tool on demand — giving it access to detail the static snapshot omits
// (every transaction, all holdings, full history) without bloating the prompt.
// Best-effort per file; returns a markdown list of the files that were written
// (for the system prompt), or '' if none. The caller deletes `dir` after the turn.
export async function exportChatData(dir: string, clientForecast?: unknown, opts: { report?: boolean } = {}): Promise<string> {
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
      `Fields: id, date (YYYY-MM-DD), amount (negative = money out/spending, positive = money in/income), ` +
      `payee, merchant (the key categories are assigned by), account, category, memo.`);
  } catch (e) { console.error('[assistant] export transactions failed:', e); }

  try {
    writeJson('accounts.json', getCurrentBreakdown(),
      'All accounts (including hidden), manual assets, and properties, with their ids, balances and categories.');
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
        'at the plan-to age, 80% range, success probability from the Monte Carlo, and a five-year trajectory). `spendingTrend` ' +
        '= trailing average spending/income and annualized trend from transactions. `taxBuckets` = ' +
        'balances by tax treatment (taxable, pre-tax, Roth, HSA, 529).');
    }
  } catch (e) { console.error('[assistant] export forecast failed:', e); }

  if (opts.report) {
    try {
      const report = writeReportFile(dir);
      if (report) files.push(report);
    } catch (e) { console.error('[assistant] export report failed:', e); }
  }

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

// How the chat model asks for a chart. It has no way to draw one itself (the
// sandbox gives it Read and nothing else), so it writes a declarative spec as
// text and the client validates and draws it (shared/chartSpec.ts — the limits
// quoted here are that validator's, so the two cannot drift). Anything that
// fails validation is shown to the user as the raw text, hence the insistence on
// plain JSON.
export function chartInstructions(): string {
  const fence = '```';
  return (
    `# Charts\n\n` +
    `You can put an interactive chart in an answer. You cannot write files, HTML ` +
    `or code; instead you describe the chart and the app draws it. Write a fenced ` +
    `block tagged \`${CHART_FENCE}\` holding exactly one JSON object, on its own ` +
    `lines, like this:\n\n` +
    `${fence}${CHART_FENCE}\n` +
    `{"type":"bar","title":"Spending by month","format":"currency",` +
    `"labels":["Aug","Sep","Oct"],` +
    `"series":[{"name":"Spending","data":[4210,3875,4490]}]}\n` +
    `${fence}\n\n` +
    `Spec fields:\n` +
    `- type: one of ${CHART_TYPES.join(', ')}. Use line or area for a trend over ` +
    `time, bar to compare categories or periods, stacked_bar for parts of a total ` +
    `across periods, pie or donut for one breakdown of a whole.\n` +
    `- title: a short plain-text title (at most ${CHART_LIMITS.maxTitleChars} characters).\n` +
    `- format: one of ${CHART_FORMATS.join(', ')}. currency values are dollars; ` +
    `percent values are already percentages (write 12.5 for 12.5%, not 0.125).\n` +
    `- labels: the x-axis categories in order (for pie/donut, the slice names). ` +
    `At most ${CHART_LIMITS.maxPoints}; at most ${CHART_LIMITS.maxSlices} for pie/donut — ` +
    `fold the smallest into "Other".\n` +
    `- series: at most ${CHART_LIMITS.maxSeries}, each {"name", "data"} with exactly one ` +
    `number per label, in the same order. pie/donut take exactly one series with ` +
    `no negative values.\n\n` +
    `Rules:\n` +
    `- Strict JSON only inside the block: double quotes, no comments, no trailing ` +
    `commas. Every data value is a plain number — no "$", "%", thousands ` +
    `separators, strings or null. A block that breaks these rules is shown to ` +
    `the user as raw text instead of a chart.\n` +
    `- Every number in a chart must come from the snapshot or the data files, ` +
    `exactly as you would quote it in text. Read the relevant file and add up ` +
    `the rows yourself (for example spending per month from transactions.jsonl); ` +
    `never estimate, interpolate or invent points to fill a chart out. If the ` +
    `data for a chart isn't there, say so instead of drawing one.\n` +
    `- For a long daily history, thin it to fit the label limit (for example one ` +
    `month-end value per month) and say that you did.\n` +
    `- Use a chart when it shows something a sentence can't: a trend over several ` +
    `periods, a comparison across several categories, or the make-up of a total — ` +
    `and whenever the user asks for one. Don't chart a single figure or a ` +
    `two-number comparison. At most two charts per answer.\n` +
    `- A chart supports the answer; it doesn't replace it. Still lead with the ` +
    `answer in words, and don't repeat every plotted value in the text.`
  );
}

// How the chat model proposes a fix. It cannot make one: the sandbox is read-only
// and stays that way. It writes the change as text and the app turns that into a
// card the user may apply (shared/assistantAction.ts for the shape, and
// services/assistantActions.ts for the check against the database that every
// preview and every apply goes through). `categories` are the user's own budget
// categories, the only ones a recategorization may name.
export function actionInstructions(categories: string[]): string {
  const fence = '```';
  return (
    `# Proposing changes\n\n` +
    `You cannot change the user's data, and you must never say or imply that you ` +
    `have. What you can do is PROPOSE a change. When the user asks you to fix, ` +
    `correct or recategorize something — or asks you to look for mistakes and you ` +
    `find one in the data — write a fenced block tagged \`${ACTION_FENCE}\` holding ` +
    `exactly one JSON object, on its own lines, like this:\n\n` +
    `${fence}${ACTION_FENCE}\n` +
    `{"type":"recategorize_merchant","merchant":"blue bottle coffee","category":"Dining",` +
    `"reason":"A coffee shop, currently under Shopping."}\n` +
    `${fence}\n\n` +
    `The app shows each block as a card with the current and the new value, and ` +
    `the user chooses Apply or Dismiss. Nothing changes unless they click Apply.\n\n` +
    `These are the only changes that exist:\n` +
    `- recategorize_merchant {"merchant","category","scope"}: categories belong to ` +
    `a merchant, not a single transaction, so this moves ALL of that merchant's ` +
    `transactions. merchant is the \`merchant\` field of a row in ` +
    `transactions.jsonl, copied exactly. category must be one of the user's ` +
    `categories: ${categories.length ? categories.join(', ') : '(none set up yet)'}. ` +
    `scope is "merchant" (the default) or "similar" (also similarly named merchants).\n` +
    `- set_sign_flip {"merchant","flipped"}: flipped true counts that merchant's ` +
    `transactions with the opposite sign (a payout or refund recorded as ` +
    `spending, or the reverse); false undoes it.\n` +
    `- set_transaction_amount {"id","amount"}: corrects one transaction. id is the ` +
    `\`id\` of a row in transactions.jsonl; amount is a positive number of dollars ` +
    `(money in or out stays as it is).\n` +
    `- set_manual_asset_value {"id","value"} and set_manual_asset_category ` +
    `{"id","category"}: id is the numeric id of an entry under manualAssets in accounts.json.\n` +
    `- set_account_category {"id","category"} and set_account_hidden {"id","hidden"}: ` +
    `id is the id of an entry under accounts in accounts.json; hidden true leaves ` +
    `the account out of net worth.\n` +
    `- set_forecast_assumption {"field","value"}: changes one input of the ` +
    `Forecast (retirement plan). See "Forecasting" below for the fields.\n` +
    `Account and manual-asset categories are: ${ACCOUNT_CATEGORIES.join(', ')}.\n\n` +
    `Rules:\n` +
    `- There is no way to delete, add, rename or merge anything, to change a ` +
    `property, a budget target, a holding, a life event or an account's ` +
    `contributions, or to touch connections and settings. If the user wants one of those, say where in the app to do it ` +
    `instead of inventing an action.\n` +
    `- Read the data file first and copy ids and merchant names exactly. A block ` +
    `that does not match the data is shown to the user as an error.\n` +
    `- One change per block, at most three blocks per answer. "reason" is ` +
    `optional: one short sentence.\n` +
    `- Only propose what the user asked for or what the data clearly supports. ` +
    `In your text, say what you are proposing and why, and leave the decision to ` +
    `them — never write as if the change were already made.\n` +
    `- Strict JSON only inside the block, as for charts.`
  );
}

// Forecast inputs the assistant may propose changing, grouped by unit so the
// model writes values the way the plan stores them. Generated from the shared
// whitelist (FORECAST_FIELDS), so the prompt and the validator cannot drift.
function forecastFieldList(): string {
  const unit: Record<string, string> = {
    rate: 'a fraction per year (0.07 means 7%)',
    fraction: 'a fraction (0.5 means 50%)',
    money: 'dollars per year, today\'s dollars',
    age: 'a whole-number age',
    years: 'a whole number of years',
    boolean: 'true or false',
  };
  const groups = new Map<string, string[]>();
  for (const [field, spec] of Object.entries(FORECAST_FIELDS)) {
    const range = spec.kind === 'boolean' ? '' : ` [${spec.min} to ${spec.max}]`;
    (groups.get(spec.kind) ?? groups.set(spec.kind, []).get(spec.kind)!).push(`${field}${range}`);
  }
  return [...groups].map(([kind, fields]) => `  - ${unit[kind]}: ${fields.join(', ')}`).join('\n');
}

// How to answer forecasting questions, and how to change the plan. The Forecast
// is a Monte Carlo that runs in the user's browser; the assistant sees its
// inputs and a summary of its last result (forecast.json), never the engine.
// `hasPlan` is false when the browser sent no forecast (never set up).
export function forecastInstructions(hasPlan: boolean): string {
  return (
    `# Forecasting\n\n` +
    (hasPlan
      ? `forecast.json holds the user's retirement plan. \`plan\` has the inputs ` +
        `(assumptions; earners, where earner 0 is the user and earner 1 the partner; ` +
        `lifeEvents; kidAges; accountContributions) and \`plan.projectionSummary\`, the ` +
        `result of the app's own simulation: success probability (the share of ` +
        `simulated futures in which the money lasts to the plan-to age), median ` +
        `net worth at the end with its 80% range, and \`trajectory\`, the projected ` +
        `net worth at five-year steps (p10 / median / p90, with income and spending ` +
        `that year). Read it before answering any planning question.\n`
      : `The user has not set up a forecast yet, so there is no plan to read. Say ` +
        `so, and point them to the Forecast tab; do not invent projections.\n`) +
    `- The simulation runs in the app, not here. You cannot run it, so never ` +
    `state what a different assumption "would" do to the success probability or ` +
    `the end balance as if you had computed it. You can explain the direction ` +
    `and rough size of an effect in words, and for an actual number propose the ` +
    `change: once the user applies it, the app re-runs the simulation and the ` +
    `next message you receive carries the new summary.\n` +
    `- If the summary carries a \`status\` saying it is out of date, an input ` +
    `changed after it was computed: say the figures are from before the change ` +
    `and that opening the Forecast tab refreshes them.\n` +
    `- Projected figures are in future (nominal) dollars. Fields ending in ` +
    `TodaysDollars are the same amounts in today's purchasing power, which is ` +
    `what the Forecast page shows by default: prefer those when quoting a ` +
    `balance, and always say which kind of dollars a figure is in. The ` +
    `trajectory is good chart material (the median, or p10 / median / p90 — ` +
    `keep one kind of dollars per chart).\n` +
    `- To change an input, propose set_forecast_assumption with one of these ` +
    `fields and a value in its range, in the unit shown (the same form the ` +
    `values have in forecast.json):\n${forecastFieldList()}\n` +
    `- Changing the plan is the user's call. Propose only what they asked for ` +
    `("retire at 62", "assume 5% returns") or one clearly labelled what-if; do ` +
    `not tune assumptions to make the outcome look better.\n` +
    `- This is planning information, not financial advice.`
  );
}

// Added when the user is looking at their quarterly report (the in-app report
// view). `hasReportFile` is false when no report has been generated yet.
export function reportInstructions(hasReportFile: boolean): string {
  return (
    `# The quarterly report\n\n` +
    `The user has their quarterly report open next to this chat, so "this", "the ` +
    `report" and questions like "why did it change" refer to it. ` +
    (hasReportFile
      ? `Its text is in ${REPORT_FILE}: Read it before answering anything about ` +
        `the report, and quote its figures. The report is a stored copy from the ` +
        `date in its description; the live snapshot above can differ. If the two ` +
        `disagree, say which one you are quoting.\n`
      : `No report has been generated yet, so there is nothing to read; say so if ` +
        `they ask about its contents, and answer from the live data instead.\n`) +
    `- A change the user applies from a card does not appear in the report until ` +
    `they regenerate it; tell them so when it matters.\n` +
    `- Tax questions (how the account mix is taxed, what pre-tax, Roth, HSA, 529 ` +
    `and taxable accounts mean for withdrawals or gains): explain how the rules ` +
    `generally work and relate that to their accounts in forecast.json ` +
    `(taxBuckets). You do not know their filing status, income for the year or ` +
    `state, so do not compute a tax bill or tell them what to do; this is general ` +
    `information, not tax advice, and a tax professional should confirm anything ` +
    `they act on.`
  );
}

export interface PromptOptions {
  categories?: string[];   // the user's budget categories (see budgetCategoryLabels)
  hasForecast?: boolean;   // the browser sent a forecast plan (forecast.json has `plan`)
  reportOpen?: boolean;    // the user is in the in-app quarterly report view
  hasReportFile?: boolean; // quarterly_report.txt was written for this turn
}

// The user's budget categories as they see them (display labels). Read by the
// chat route and passed in, so systemPrompt itself never touches the database.
export function budgetCategoryLabels(): string[] {
  try {
    const lab = getCategoryLabeler();
    return getActiveCategories().map(c => lab.label(c));
  } catch (e) {
    console.error('[assistant] categories for prompt failed:', e);
    return [];
  }
}

export function systemPrompt(context: string, dataFiles = '', opts: PromptOptions = {}): string {
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
    `${chartInstructions()}\n\n` +
    `${actionInstructions(opts.categories ?? [])}\n\n` +
    `${forecastInstructions(!!opts.hasForecast)}\n\n` +
    (opts.reportOpen ? `${reportInstructions(!!opts.hasReportFile)}\n\n` : '') +
    `# Current financial snapshot\n\n${context || '(No financial data available yet.)'}` +
    (dataFiles ? `\n\n# Detailed data files\n\n${dataFiles}` : '')
  );
}
