import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { getNetWorthHistory, getCurrentBreakdown, getTaxBuckets } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getSpendingProjection } from './budget.js';
import { findClaudeBinary, NO_TOOLS_CLAUDE_ARGS } from './assistant.js';
import {
  getReportWindow, quarterMonthKeys, computePeriodFigures, outlookHorizon, type ReportWindow,
} from '../util/reportWindow.js';
import {
  renderReportHtml, type ReportModel, type ReportGroup, type ReportSlice,
  type ReportSignal, type ReportBucket, type SectionStatus,
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

function buildGroups(): {
  groups: ReportGroup[]; status: SectionStatus; currentTotal: number | null;
  cashTotal: number; reEquity: number; propertyCount: number;
} {
  let cashTotal = 0;
  let reEquity = 0;
  let propertyCount = 0;
  try {
    // Shape comes from the shared API contract now — no local structural cast.
    const { accounts, manualAssets, properties } = getCurrentBreakdown();
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
      propertyCount = properties.length;
      reEquity = re.subtotal;
      groups.splice(Math.min(2, groups.length), 0, re); // after investments & cash
    }
    const currentTotal = groups.reduce((sum, g) => sum + g.subtotal, 0);
    return { groups, status: groups.length ? 'ok' : 'empty', currentTotal, cashTotal, reEquity, propertyCount };
  } catch (e) {
    console.error('[report] groups failed:', e);
    return { groups: [], status: 'failed', currentTotal: null, cashTotal: 0, reEquity: 0, propertyCount: 0 };
  }
}

async function buildAllocation(): Promise<{ slices: ReportSlice[]; status: SectionStatus }> {
  try {
    const a = await getAllocation();
    if (!a.total) return { slices: [], status: 'empty' };
    const slices = a.byAssetClass
      .filter(s => s.pct > 0)
      .map(s => ({ label: s.name, pct: s.pct * 100 }))
      .sort((x, y) => y.pct - x.pct);
    if (!slices.length) return { slices, status: 'empty' };
    if (slices.length <= 6) return { slices, status: 'ok' };
    const head = slices.slice(0, 5);
    const rest = slices.slice(5).reduce((sum, s) => sum + s.pct, 0);
    return { slices: [...head, { label: 'Other', pct: rest }], status: 'ok' };
  } catch (e) {
    console.error('[report] allocation failed:', e);
    return { slices: [], status: 'failed' };
  }
}

type Cashflow = ReportModel['cashflow'];

async function buildCashflow(w: ReportWindow): Promise<Cashflow> {
  try {
    const keys = new Set(quarterMonthKeys(w));
    const { months } = await getSpendingProjection();
    let income = 0, spending = 0;
    for (const mo of months) if (keys.has(mo.month)) { income += mo.income; spending += mo.spending; }
    const saved = income - spending;
    // No income AND no spending means the quarter had no transactions (e.g. data
    // not yet synced) — that's "not available", not a real $0 quarter.
    const status: SectionStatus = income === 0 && spending === 0 ? 'empty' : 'ok';
    return { income, spending, saved, savingsRate: income > 0 ? saved / income : null, status };
  } catch (e) {
    console.error('[report] cashflow failed:', e);
    return { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'failed' };
  }
}

function buildTaxBuckets(): { buckets: ReportBucket[]; status: SectionStatus } {
  try {
    const { totals } = getTaxBuckets() as { totals: Record<string, number> };
    const buckets = Object.entries(totals)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ label: TAX_LABELS[k] ?? k, value: v }))
      .sort((a, b) => b.value - a.value);
    return { buckets, status: buckets.length ? 'ok' : 'empty' };
  } catch (e) {
    console.error('[report] tax buckets failed:', e);
    return { buckets: [], status: 'failed' };
  }
}

// Plain-language savings sentence; a negative rate means spending exceeded income.
export function savingsNote(rate: number): string {
  const r = Math.round(rate * 100);
  return r < 0
    ? `You spent ${Math.abs(r)}% more than you earned this quarter.`
    : `You kept ${r}% of what you earned this quarter.`;
}

export function buildSignals(
  cashTotal: number,
  cf: { spending: number; savingsRate: number | null; status?: SectionStatus },
  yoyPct: number | null,
): ReportSignal[] {
  const out: ReportSignal[] = [];
  const cfOk = (cf.status ?? 'ok') === 'ok';
  const monthlySpend = cf.spending / 3;
  if (cfOk && monthlySpend > 0 && cashTotal > 0) {
    const runway = cashTotal / monthlySpend;
    out.push({
      tag: runway >= 6 ? 'On track' : runway >= 3 ? 'Adequate' : 'Thin',
      tone: runway >= 6 ? 'good' : runway >= 3 ? 'neutral' : 'watch',
      label: 'Emergency runway', value: `${runway.toFixed(1)} mo`,
      note: `Current cash reserves cover about ${runway.toFixed(1)} months of spending${runway >= 6 ? ' — above the usual 6-month target.' : '.'}`,
    });
  }
  if (cfOk && cf.savingsRate != null) {
    const r = Math.round(cf.savingsRate * 100);
    out.push({
      tag: r >= 20 ? 'Strong' : r >= 10 ? 'Steady' : r < 0 ? 'Negative' : 'Low',
      tone: r >= 20 ? 'good' : r >= 10 ? 'neutral' : 'watch',
      label: 'Savings rate', value: `${r}%`,
      note: savingsNote(cf.savingsRate),
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

export function deterministicNote(m: Omit<ReportModel, 'analystNote' | 'noteSource'>): string {
  const dir = (m.netWorthChange ?? 0) >= 0 ? 'rose' : 'fell';
  const parts: string[] = [];
  const chg = m.netWorthChange != null && m.netWorthChangePct != null
    ? ` — ${dir} $${Math.abs(Math.round(m.netWorthChange)).toLocaleString('en-US')} (${(Math.abs(m.netWorthChangePct) * 100).toFixed(1)}%) over the quarter`
    : '';
  parts.push(`Your net worth closed ${m.quarterLabel} at $${Math.round(m.netWorth).toLocaleString('en-US')}${chg}.`);
  const cf = m.cashflow;
  if (cf.status === 'ok' && cf.savingsRate != null) {
    const income = `$${Math.round(cf.income).toLocaleString('en-US')}`;
    parts.push(cf.saved >= 0
      ? `You saved $${Math.round(cf.saved).toLocaleString('en-US')} of the ${income} you earned — a ${Math.round(cf.savingsRate * 100)}% savings rate.`
      : `You spent $${Math.abs(Math.round(cf.saved)).toLocaleString('en-US')} more than the ${income} you earned — a ${Math.abs(Math.round(cf.savingsRate * 100))}% shortfall.`);
  }
  const runway = m.signals.find(s => s.label === 'Emergency runway');
  if (runway) parts.push(runway.note);
  return parts.join(' ');
}

export interface AdviceItem { action: string; why: string }
export interface Advisory {
  note?: string;
  marketView?: string[];
  taxActions?: AdviceItem[];
  estateActions?: AdviceItem[];
}

// Validate and normalize an array of {action, why} advice items (tax, estate).
// Drops malformed entries and caps the count.
function parseAdviceItems(v: unknown, cap: number): AdviceItem[] {
  return (Array.isArray(v) ? v : [])
    .filter((x): x is AdviceItem => {
      if (!x || typeof x !== 'object') return false;
      const r = x as Record<string, unknown>;
      return typeof r.action === 'string' && r.action.trim().length > 0
        && typeof r.why === 'string' && r.why.trim().length > 0;
    })
    .map(x => ({ action: x.action.trim(), why: x.why.trim() })).slice(0, cap);
}

// Extract the advisory JSON from the model's raw text (which may be wrapped in
// prose or ```json fences). Pure + exported so it can be unit-tested without the
// binary. Returns null when nothing usable is present.
export function parseAdvisory(resultText: string): Advisory | null {
  if (!resultText) return null;
  let txt = resultText.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf('{'), end = txt.lastIndexOf('}');
  if (start < 0 || end < start) return null;

  let o: Record<string, unknown>;
  try { o = JSON.parse(txt.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }

  const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim() : undefined;
  const marketView = (Array.isArray(o.marketView) ? o.marketView : [])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim()).slice(0, 6);
  const taxActions = parseAdviceItems(o.taxActions, 7);
  const estateActions = parseAdviceItems(o.estateActions, 6);

  if (!note && !marketView.length && !taxActions.length && !estateActions.length) return null;
  return {
    note,
    marketView: marketView.length ? marketView : undefined,
    taxActions: taxActions.length ? taxActions : undefined,
    estateActions: estateActions.length ? estateActions : undefined,
  };
}

// Ask the locally-installed Claude binary (same one the assistant uses — no API
// key, nothing leaves the machine) for the advisory content: the analyst's note
// plus the forward-looking market view and tax-aware actions. Best-effort — if
// the binary is missing, not logged in, slow, or returns junk, we return null and
// the caller falls back to the deterministic (statement-only) report. Never throws.
// System prompt, parameterised on the real report quarter and generation date so
// the outlook horizon is right whenever the report is produced. Exported for tests.
export function buildAdvisorySystemPrompt(w: ReportWindow, now: Date): string {
  const h = outlookHorizon(now);
  return (
    'You are a CFA- and CFP-style writer producing the advisory content for a personal ' +
    `quarterly net-worth statement, dated ${h.generatedOn} and reporting on the just-ended quarter, ` +
    `${w.quarterLabel}. ` +
    'Using ONLY the figures provided, reason carefully and return STRICT JSON (no prose, no ' +
    'code fences) with exactly these keys:\n' +
    '- "note": 2 short paragraphs (~110 words total) interpreting the quarter — what drove the ' +
    'change, what is healthy, and one thing to watch.\n' +
    '- "marketView": an array of 3–6 detailed, forward-looking bullets on the outlook for ' +
    `${h.restOfYear} and into ${h.nextPeriod}. Address rates/inflation, equity and ` +
    'fixed-income markets, and — most importantly — what each point implies for THIS ' +
    "portfolio's allocation and cash position. Scenario-frame them (base / bull / bear where " +
    'useful) and hedge with house-view language; never give guarantees or price targets.\n' +
    '- "taxActions": an array of 4–7 objects {"action","why"} — specific, detailed ' +
    'tax-efficiency moves grounded in the account mix and cash flow (e.g. asset location, ' +
    'tax-loss harvesting, Roth conversions in lower-income years, maxing HSA / backdoor or ' +
    'mega-backdoor Roth where the mix suggests headroom, donor-advised funds or QCDs, ' +
    'tax-bracket and capital-gains management). Each "why" is 1–2 sentences tied to the ' +
    'figures. No specific securities.\n' +
    '- "estateActions": an array of 3–5 objects {"action","why"} — general estate- and ' +
    'legacy-planning considerations scaled to this net worth and holdings (e.g. will and/or ' +
    'revocable living trust, beneficiary designations and TOD/POD titling, how real estate is ' +
    'held, annual-exclusion gifting, durable power of attorney and healthcare directives, ' +
    'umbrella liability coverage, and digital-asset access). Each "why" is 1–2 sentences.\n' +
    'Do not give specific buy/sell advice, do not name products or securities, and do not add ' +
    'disclaimers (the statement adds its own). Output JSON only.'
  );
}

async function aiAdvisory(summary: string, system: string): Promise<Advisory | null> {
  const bin = findClaudeBinary();
  if (!bin) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kevfin-report-'));
  return await new Promise<Advisory | null>(resolve => {
    let done = false;
    const finish = (v: Advisory | null) => {
      if (done) return; done = true;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Everything the model needs is in the prompt, so it gets NO tools at all
      // (see NO_TOOLS_CLAUDE_ARGS) — it can't read files, run commands or reach the
      // network. The prompt goes over stdin so it can never be parsed as a flag.
      child = spawn(bin, [
        '-p',
        '--model', 'claude-opus-4-8',
        '--system-prompt', system,
        ...NO_TOOLS_CLAUDE_ARGS,
        '--output-format', 'json',
      // Ignore stderr rather than leave an unread pipe: if the binary filled
      // it, it would block and the 90 s timeout would fire on every report.
      ], { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin!.on('error', () => { /* child exited before reading the prompt */ });
      child.stdin!.end(summary);
    } catch (e) { console.error('[report] advisory spawn failed:', e); return finish(null); }

    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, 90_000);
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const obj = JSON.parse(out.trim());
        if (obj.is_error || typeof obj.result !== 'string') return finish(null);
        return finish(parseAdvisory(obj.result));
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
  // Headline figures come from the period-END snapshot (not whatever is latest),
  // and the change is measured from a dated baseline we print on the report.
  const fig = computePeriodFigures(history, w);
  const netWorth = fig.endSnap?.net_worth ?? 0;
  const { change: netWorthChange, changePct: netWorthChangePct, yoyPct } = fig;

  const { groups, status: groupsStatus, currentTotal, cashTotal, reEquity, propertyCount } = buildGroups();
  const [alloc, cashflow] = await Promise.all([buildAllocation(), buildCashflow(w)]);
  const allocation = alloc.slices;
  const { buckets: taxBuckets, status: taxStatus } = buildTaxBuckets();
  const signals = buildSignals(cashTotal, cashflow, yoyPct);
  const today = now.toISOString().slice(0, 10);

  const base: Omit<ReportModel, 'analystNote' | 'noteSource'> = {
    quarterLabel: w.quarterLabel,
    periodLabel: periodLabel(w),
    generatedAt: fmtDay(today),
    asOf: fig.endSnap ? fmtDay(fig.endSnap.date) : null,
    netWorth, netWorthChange, netWorthChangePct, yoyPct,
    deltaFrom: netWorthChange != null && fig.startSnap ? fmtDay(fig.startSnap.date) : null,
    groups, groupsStatus, currentTotal,
    allocation, allocationStatus: alloc.status,
    cashflow, taxBuckets, taxStatus, signals,
  };

  // Compact figures for the model to reason over (numbers only — no raw records).
  const cfOk = cashflow.status === 'ok';
  const summary =
    `Quarter: ${w.quarterLabel} (${periodLabel(w)}).\n` +
    `Net worth${fig.endSnap ? ` as of ${fig.endSnap.date}` : ''}: $${Math.round(netWorth).toLocaleString('en-US')}` +
    (netWorthChange != null ? `, change this quarter ${netWorthChange >= 0 ? '+' : ''}$${Math.round(netWorthChange).toLocaleString('en-US')}` : '') +
    (netWorthChangePct != null ? ` (${(netWorthChangePct * 100).toFixed(1)}%)` : '') +
    (fig.startSnap && netWorthChange != null ? ` since ${fig.startSnap.date}` : '') +
    (yoyPct != null ? `, year-over-year ${(yoyPct * 100).toFixed(1)}%` : ', year-over-year not available (insufficient history)') + '.\n' +
    (cfOk
      ? `Cash flow: income $${Math.round(cashflow.income).toLocaleString('en-US')}, spending $${Math.round(cashflow.spending).toLocaleString('en-US')}, saved $${Math.round(cashflow.saved).toLocaleString('en-US')}` +
        (cashflow.savingsRate != null ? ` (${Math.round(cashflow.savingsRate * 100)}% savings rate)` : '') + '.\n'
      : 'Cash flow: not available for this quarter.\n') +
    (allocation.length ? `Allocation (current): ${allocation.map(s => `${s.label} ${s.pct.toFixed(0)}%`).join(', ')}.\n` : '') +
    `Liquid cash (current): $${Math.round(cashTotal).toLocaleString('en-US')}.\n` +
    (propertyCount ? `Real estate: ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}, equity $${Math.round(reEquity).toLocaleString('en-US')}.\n` : '') +
    (taxBuckets.length ? `Tax treatment (current): ${taxBuckets.map(b => `${b.label} $${Math.round(b.value).toLocaleString('en-US')}`).join(', ')}.\n` : '') +
    (signals.length ? `Signals: ${signals.map(s => `${s.label} ${s.value}`).join('; ')}.` : '');

  const advisory = await aiAdvisory(summary, buildAdvisorySystemPrompt(w, now));
  const model: ReportModel = advisory?.note
    ? {
        ...base,
        analystNote: advisory.note,
        noteSource: 'assistant',
        marketView: advisory.marketView,
        taxActions: advisory.taxActions,
        estateActions: advisory.estateActions,
      }
    : { ...base, analystNote: deterministicNote(base), noteSource: 'summary' };

  return renderReportHtml(model);
}

export { getReportWindow };
