import { existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { getNetWorthHistory, getCurrentBreakdown } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getBudget } from './budget.js';

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

export function systemPrompt(context: string): string {
  return (
    `You are the built-in financial assistant for KevFin, a personal net-worth ` +
    `tracker. The user is the owner of this data and is asking about their own ` +
    `finances. Answer their questions using the live snapshot of their accounts, ` +
    `investments, real estate, and budget provided below.\n\n` +
    `Guidelines:\n` +
    `- Be concise and direct. Lead with the answer, then any supporting detail.\n` +
    `- Use the figures from the snapshot; format money clearly (e.g. $1,234).\n` +
    `- If the data needed to answer isn't in the snapshot, say so plainly rather ` +
    `than guessing. Don't fabricate numbers.\n` +
    `- You can offer observations and general financial education, but make clear ` +
    `you are not a licensed financial advisor and avoid specific buy/sell advice.\n\n` +
    `# Current financial snapshot\n\n${context || '(No financial data available yet.)'}`
  );
}
