import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { getNetWorthHistory, getCurrentBreakdown, getTaxBuckets } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getSpendingProjection } from './budget.js';
import { findClaudeBinary } from './assistant.js';
import { getReportWindow, quarterMonthKeys, type ReportWindow } from '../util/reportWindow.js';
import {
  renderReportHtml, type ReportModel, type ReportGroup, type ReportSlice,
  type ReportSignal, type ReportBucket,
} from './reportTemplate.js';

interface Snapshot { date: string; accounts_total: number; real_estate_total: number; net_worth: number }

// category → statement group heading, in the order groups should appear.
const GROUP_META: { cat: string; name: string; order: number }[] = [
  { cat: 'brokerage', name: 'Investments & retirement', order: 1 },
  { cat: 'banking', name: 'Cash & banking', order: 2 },
  { cat: 'other', name: 'Other accounts', order: 4 },
  { cat: 'credit', name: 'Liabilities', order: 5 },
];
const TAX_LABELS: Record<string, string> = {
  taxable: 'Taxable', pretax: 'Pre-tax', roth: 'Roth', hsa: 'HSA', college: 'College / 529',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function periodLabel(w: ReportWindow): string {
  const [ys, ms, ds] = w.periodStart.split('-').map(Number);
  const [ye, me, de] = w.periodEnd.split('-').map(Number);
  const startYear = ys === ye ? '' : ` ${ys}`;
  return `${ds} ${MONTHS[ms - 1]}${startYear} – ${de} ${MONTHS[me - 1]} ${ye}`;
}

// --- data gathering (best-effort per section) -------------------------------

function buildGroups(): { groups: ReportGroup[]; cashTotal: number } {
  let cashTotal = 0;
  try {
    const { accounts, manualAssets, properties } = getCurrentBreakdown() as {
      accounts: { name: string; org_name: string; category: string; balance: number; hidden: number }[];
      manualAssets: { name: string; category: string; value: number }[];
      properties: { address: string; zestimate: number | null; mortgage_balance: number }[];
    };
    const byCat = new Map<string, ReportGroup>();
    for (const meta of GROUP_META) byCat.set(meta.cat, { name: meta.name, subtotal: 0, rows: [] });

    for (const a of accounts) {
      if (a.hidden) continue;
      const g = byCat.get(a.category) ?? byCat.get('other')!;
      g.rows.push({ name: a.name, org: a.org_name, balance: a.balance });
      g.subtotal += a.balance;
      if (a.category === 'banking') cashTotal += a.balance;
    }
    for (const ma of manualAssets) {
      const g = byCat.get('other')!;
      g.rows.push({ name: ma.name, org: 'Manual asset', balance: ma.value });
      g.subtotal += ma.value;
    }
    const groups: ReportGroup[] = GROUP_META
      .map(meta => ({ meta, g: byCat.get(meta.cat)! }))
      .filter(x => x.g.rows.length)
      .sort((a, b) => a.meta.order - b.meta.order)
      .map(x => x.g);

    if (properties.length) {
      const re: ReportGroup = { name: 'Real estate (equity)', subtotal: 0, rows: [] };
      for (const p of properties) {
        const equity = (p.zestimate ?? 0) - (p.mortgage_balance ?? 0);
        re.rows.push({ name: p.address, org: 'Property equity', balance: equity });
        re.subtotal += equity;
      }
      groups.splice(Math.min(2, groups.length), 0, re); // after investments & cash
    }
    return { groups, cashTotal };
  } catch (e) {
    console.error('[report] groups failed:', e);
    return { groups: [], cashTotal: 0 };
  }
}

async function buildAllocation(): Promise<ReportSlice[]> {
  try {
    const a = await getAllocation();
    if (!a.total) return [];
    const slices = a.byAssetClass
      .filter(s => s.pct > 0)
      .map(s => ({ label: s.name, pct: s.pct * 100 }))
      .sort((x, y) => y.pct - x.pct);
    if (slices.length <= 6) return slices;
    const head = slices.slice(0, 5);
    const rest = slices.slice(5).reduce((sum, s) => sum + s.pct, 0);
    return [...head, { label: 'Other', pct: rest }];
  } catch (e) {
    console.error('[report] allocation failed:', e);
    return [];
  }
}

async function buildCashflow(w: ReportWindow) {
  try {
    const keys = new Set(quarterMonthKeys(w));
    const { months } = await getSpendingProjection();
    let income = 0, spending = 0;
    for (const mo of months) if (keys.has(mo.month)) { income += mo.income; spending += mo.spending; }
    const saved = income - spending;
    return { income, spending, saved, savingsRate: income > 0 ? saved / income : null };
  } catch (e) {
    console.error('[report] cashflow failed:', e);
    return { income: 0, spending: 0, saved: 0, savingsRate: null };
  }
}

function buildTaxBuckets(): ReportBucket[] {
  try {
    const { totals } = getTaxBuckets() as { totals: Record<string, number> };
    return Object.entries(totals)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ label: TAX_LABELS[k] ?? k, value: v }))
      .sort((a, b) => b.value - a.value);
  } catch (e) {
    console.error('[report] tax buckets failed:', e);
    return [];
  }
}

function buildSignals(
  cashTotal: number,
  cf: { spending: number; savingsRate: number | null },
  yoyPct: number | null,
): ReportSignal[] {
  const out: ReportSignal[] = [];
  const monthlySpend = cf.spending / 3;
  if (monthlySpend > 0 && cashTotal > 0) {
    const runway = cashTotal / monthlySpend;
    out.push({
      tag: runway >= 6 ? 'On track' : runway >= 3 ? 'Adequate' : 'Thin',
      tone: runway >= 6 ? 'good' : runway >= 3 ? 'neutral' : 'watch',
      label: 'Emergency runway', value: `${runway.toFixed(1)} mo`,
      note: `Cash reserves cover about ${Math.round(runway)} months of spending${runway >= 6 ? ' — above the usual 6-month target.' : '.'}`,
    });
  }
  if (cf.savingsRate != null) {
    const r = Math.round(cf.savingsRate * 100);
    out.push({
      tag: r >= 20 ? 'Strong' : r >= 10 ? 'Steady' : 'Low',
      tone: r >= 20 ? 'good' : r >= 10 ? 'neutral' : 'watch',
      label: 'Savings rate', value: `${r}%`,
      note: `You kept ${r}% of what you earned this quarter.`,
    });
  }
  if (yoyPct != null) {
    out.push({
      tag: yoyPct >= 0 ? 'Growing' : 'Down', tone: yoyPct >= 0 ? 'good' : 'watch',
      label: 'Net worth, 1 year', value: `${yoyPct >= 0 ? '+' : '−'}${(Math.abs(yoyPct) * 100).toFixed(1)}%`,
      note: `Net worth is ${yoyPct >= 0 ? 'up' : 'down'} versus a year ago.`,
    });
  }
  return out;
}

// --- analyst note -----------------------------------------------------------

function deterministicNote(m: Omit<ReportModel, 'analystNote' | 'noteSource'>): string {
  const dir = (m.netWorthChange ?? 0) >= 0 ? 'rose' : 'fell';
  const parts: string[] = [];
  const chg = m.netWorthChange != null && m.netWorthChangePct != null
    ? ` — ${dir} $${Math.abs(Math.round(m.netWorthChange)).toLocaleString('en-US')} (${(m.netWorthChangePct * 100).toFixed(1)}%) over the quarter`
    : '';
  parts.push(`Your net worth closed ${m.quarterLabel} at $${Math.round(m.netWorth).toLocaleString('en-US')}${chg}.`);
  if (m.cashflow.savingsRate != null) {
    parts.push(`You saved $${Math.round(m.cashflow.saved).toLocaleString('en-US')} of the $${Math.round(m.cashflow.income).toLocaleString('en-US')} you earned — a ${Math.round(m.cashflow.savingsRate * 100)}% savings rate.`);
  }
  const runway = m.signals.find(s => s.label === 'Emergency runway');
  if (runway) parts.push(runway.note);
  return parts.join(' ');
}

// Ask the locally-installed Claude binary (same one the assistant uses — no API
// key, nothing leaves the machine) for a short advisory note. Best-effort: if
// the binary is missing, not logged in, or slow, we fall back to the
// deterministic summary. Never throws.
async function aiNote(summary: string): Promise<string | null> {
  const bin = findClaudeBinary();
  if (!bin) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kevfin-report-'));
  const system =
    'You are a CFA-style financial writer producing the "analyst\'s note" for a ' +
    'personal quarterly net-worth statement. Write 2 short paragraphs (max ~90 words total), ' +
    'plain prose, warm but precise. Interpret the numbers — what drove the change, what is ' +
    'healthy, one thing to watch. Use only the figures given. Do not give specific buy/sell ' +
    'advice or guarantees, and do not add a disclaimer. Output the note text only.';
  return await new Promise<string | null>(resolve => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return; done = true;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [
        '-p', summary,
        '--model', 'claude-opus-4-8',
        '--system-prompt', system,
        '--allowedTools', 'Read',
        '--output-format', 'json',
      ], { cwd: dir, env: process.env });
    } catch (e) { console.error('[report] ai note spawn failed:', e); return finish(null); }

    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, 60_000);
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const obj = JSON.parse(out.trim());
        if (obj.is_error || typeof obj.result !== 'string' || !obj.result.trim()) return finish(null);
        return finish(obj.result.trim());
      } catch { return finish(null); }
    });
  });
}

// --- public entry point -----------------------------------------------------

export async function generateQuarterlyReport(now = new Date()): Promise<string> {
  const w = getReportWindow(now);

  const history = (getNetWorthHistory(100000) as Snapshot[])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = history[history.length - 1];
  const netWorth = latest?.net_worth ?? 0;

  const startSnap = history.find(s => s.date >= w.periodStart);
  const netWorthChange = latest && startSnap ? latest.net_worth - startSnap.net_worth : null;
  const netWorthChangePct = netWorthChange != null && startSnap && startSnap.net_worth
    ? netWorthChange / startSnap.net_worth : null;

  let yoyPct: number | null = null;
  if (latest) {
    const cutoff = new Date(new Date(latest.date + 'T00:00:00Z').getTime() - 365 * 86400_000)
      .toISOString().slice(0, 10);
    const yearAgo = history.find(s => s.date >= cutoff);
    if (yearAgo && yearAgo.net_worth && yearAgo.date < latest.date) {
      yoyPct = (latest.net_worth - yearAgo.net_worth) / yearAgo.net_worth;
    }
  }

  const { groups, cashTotal } = buildGroups();
  const [allocation, cashflow] = await Promise.all([buildAllocation(), buildCashflow(w)]);
  const taxBuckets = buildTaxBuckets();
  const signals = buildSignals(cashTotal, cashflow, yoyPct);

  const base: Omit<ReportModel, 'analystNote' | 'noteSource'> = {
    quarterLabel: w.quarterLabel,
    periodLabel: periodLabel(w),
    generatedAt: fmtDay(now.toISOString().slice(0, 10)),
    netWorth, netWorthChange, netWorthChangePct, yoyPct,
    groups, allocation, cashflow, taxBuckets, signals,
  };

  // Compact figures for the model to reason over (numbers only — no raw records).
  const summary =
    `Quarter: ${w.quarterLabel} (${periodLabel(w)}).\n` +
    `Net worth: $${Math.round(netWorth).toLocaleString('en-US')}` +
    (netWorthChange != null ? `, change this quarter ${netWorthChange >= 0 ? '+' : ''}$${Math.round(netWorthChange).toLocaleString('en-US')}` : '') +
    (netWorthChangePct != null ? ` (${(netWorthChangePct * 100).toFixed(1)}%)` : '') +
    (yoyPct != null ? `, year-over-year ${(yoyPct * 100).toFixed(1)}%` : '') + '.\n' +
    `Cash flow: income $${Math.round(cashflow.income).toLocaleString('en-US')}, spending $${Math.round(cashflow.spending).toLocaleString('en-US')}, saved $${Math.round(cashflow.saved).toLocaleString('en-US')}` +
    (cashflow.savingsRate != null ? ` (${Math.round(cashflow.savingsRate * 100)}% savings rate)` : '') + '.\n' +
    (allocation.length ? `Allocation: ${allocation.map(s => `${s.label} ${s.pct.toFixed(0)}%`).join(', ')}.\n` : '') +
    (signals.length ? `Signals: ${signals.map(s => `${s.label} ${s.value}`).join('; ')}.` : '');

  const ai = await aiNote(summary);
  const model: ReportModel = ai
    ? { ...base, analystNote: ai, noteSource: 'assistant' }
    : { ...base, analystNote: deterministicNote(base), noteSource: 'summary' };

  return renderReportHtml(model);
}

export { getReportWindow };
