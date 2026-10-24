import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from '../db/schema.js';
import { getNetWorthHistory, getCurrentBreakdown, getTaxBuckets } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getBudget, getCategoryLabeler } from './budget.js';
import { getObservations } from './observations.js';
import { findClaudeBinary, NO_TOOLS_CLAUDE_ARGS } from './assistant.js';
import {
  getReportWindow, quarterMonthKeys, computePeriodFigures, outlookHorizon, nearestObservation, priorWindow,
  type ReportWindow,
} from '../util/reportWindow.js';
import {
  attributeChange, monthEndSeries, monthLabel, fmtMoney, fmtSigned, fmtDateUS, fmtRangeUS, type Attribution,
} from '../util/reportCharts.js';
import {
  renderReportHtml, type ReportModel, type ReportAccount, type ReportSlice, type ReportCashflow,
  type ReportSignal, type ReportBucket, type ReportKpi, type SectionStatus,
} from './reportTemplate.js';

interface Snapshot { date: string; accounts_total: number; real_estate_total: number; net_worth: number }

const TAX_LABELS: Record<string, string> = {
  taxable: 'Taxable', pretax: 'Pre-tax', roth: 'Roth', hsa: 'HSA', college: 'College / 529',
};
const fmtDay = (iso: string) => fmtDateUS(iso);
const fmtShort = (iso: string) => fmtDateUS(iso, false);
const periodLabel = (w: ReportWindow) => fmtRangeUS(w.periodStart, w.periodEnd);

// --- data gathering (best-effort per section) -------------------------------

interface AccountsResult {
  accounts: ReportAccount[]; status: SectionStatus; showChange: boolean;
  cashTotal: number; reEquity: number; propertyCount: number;
}

// Flat list of every visible account, manual asset and property's equity. When the
// balance_observations table has a reading within ~7 days of BOTH the quarter's
// start and end snapshots, the row carries its change over the quarter; if no row
// can, the change column is dropped entirely rather than faked.
function buildAccounts(startDate: string | null, endDate: string | null): AccountsResult {
  let cashTotal = 0, reEquity = 0, propertyCount = 0;
  try {
    const { accounts, manualAssets, properties } = getCurrentBreakdown();
    const db = getDb();
    const change = (key: string): number | null => {
      if (!startDate || !endDate) return null;
      try {
        const obs = getObservations(db, key);
        const a = nearestObservation(obs, startDate), b = nearestObservation(obs, endDate);
        return a && b && a.date !== b.date ? b.balance - a.balance : null;
      } catch { return null; }
    };
    const rows: ReportAccount[] = [];
    for (const a of accounts) {
      if (a.hidden) continue;
      rows.push({ name: a.name, org: a.org_name, balance: a.balance, change: change(a.id) });
      if (a.category === 'banking') cashTotal += a.balance;
    }
    for (const ma of manualAssets) rows.push({ name: ma.name, org: 'Manual asset', balance: ma.value, change: change(`manual:${ma.id}`) });
    for (const p of properties) {
      const equity = (p.zestimate ?? 0) - (p.mortgage_balance ?? 0);
      rows.push({ name: `${p.address} (equity)`, org: 'Home', balance: equity, change: change(`property:${p.id}`) });
      reEquity += equity;
      propertyCount++;
    }
    const showChange = rows.some(r => typeof r.change === 'number');
    return { accounts: rows, status: rows.length ? 'ok' : 'empty', showChange, cashTotal, reEquity, propertyCount };
  } catch (e) {
    console.error('[report] accounts failed:', e);
    return { accounts: [], status: 'failed', showChange: false, cashTotal: 0, reEquity: 0, propertyCount: 0 };
  }
}

async function buildAllocation(): Promise<{ slices: ReportSlice[]; total: number | null; status: SectionStatus }> {
  try {
    const a = await getAllocation();
    if (!a.total) return { slices: [], total: null, status: 'empty' };
    const slices = a.byAssetClass
      .filter(s => s.pct > 0)
      .map(s => ({ label: s.name, pct: s.pct * 100 }))
      .sort((x, y) => y.pct - x.pct);
    if (!slices.length) return { slices, total: a.total, status: 'empty' };
    if (slices.length <= 6) return { slices, total: a.total, status: 'ok' };
    const head = slices.slice(0, 5);
    const rest = slices.slice(5).reduce((sum, s) => sum + s.pct, 0);
    return { slices: [...head, { label: 'Other', pct: rest }], total: a.total, status: 'ok' };
  } catch (e) {
    console.error('[report] allocation failed:', e);
    return { slices: [], total: null, status: 'failed' };
  }
}

// The slice of getBudget()'s summary the report needs.
export interface MonthCash {
  income: number; spending: number; mortgage: number;
  byCategory: { category: string; spent: number }[];
}

// Pure: fold per-month budget summaries (null = no data that month) into the
// quarter's cash-flow figures. Spending INCLUDES mortgage payments — getBudget
// reports them separately ("excluded from spending") but they are real cash out,
// and counting them keeps income − spending equal to cash actually saved, which
// is what the net-worth waterfall needs (principal paid shows up in home equity).
export function aggregateCashflow(
  keys: string[], months: (MonthCash | null)[], label: (cat: string) => string, topN = 6,
): ReportCashflow {
  let income = 0, spending = 0;
  const cats = new Map<string, number>();
  const out = keys.map((k, i) => {
    const m = months[i];
    const inc = m?.income ?? 0;
    const spend = m ? m.spending + m.mortgage : 0;
    income += inc; spending += spend;
    if (m) {
      for (const c of m.byCategory) if (c.spent > 0) cats.set(c.category, (cats.get(c.category) ?? 0) + c.spent);
      if (m.mortgage > 0) cats.set('Mortgage', (cats.get('Mortgage') ?? 0) + m.mortgage);
    }
    return { label: monthLabel(k), income: Math.round(inc), spending: Math.round(spend) };
  });
  const sorted = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN).map(([c, v]) => ({ label: label(c), amount: Math.round(v) }));
  const topSum = sorted.slice(0, topN).reduce((s, [, v]) => s + v, 0);
  const saved = income - spending;
  const status: SectionStatus = income === 0 && spending === 0 ? 'empty' : 'ok';
  return {
    income, spending, saved, savingsRate: income > 0 ? saved / income : null, status,
    months: out, categories: top, other: Math.max(0, Math.round(spending - topSum)),
  };
}

async function buildCashflow(w: Pick<ReportWindow, 'quarter' | 'year'>): Promise<ReportCashflow> {
  try {
    const keys = quarterMonthKeys(w);
    const labeler = getCategoryLabeler();
    const months = await Promise.all(keys.map(async (k): Promise<MonthCash | null> => {
      const s = await getBudget(k);
      // getBudget silently falls back to the latest month when asked for one it has
      // no transactions in — treat that as "no data", not as that other month's data.
      if (s.month !== k) return null;
      return { income: s.income, spending: s.spending, mortgage: s.mortgage, byCategory: s.byCategory.filter(c => !c.excluded) };
    }));
    return aggregateCashflow(keys, months, c => labeler.label(c));
  } catch (e) {
    console.error('[report] cashflow failed:', e);
    return { income: 0, spending: 0, saved: 0, savingsRate: null, status: 'failed', months: [], categories: [], other: 0 };
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
export function savingsNote(rate: number, prior?: { label: string; rate: number | null } | null): string {
  const r = Math.round(rate * 100);
  const base = r < 0
    ? `You spent ${Math.abs(r)}% more than you earned this quarter`
    : `You kept ${r}% of what you earned this quarter`;
  return prior && prior.rate != null ? `${base} (${Math.round(prior.rate * 100)}% in ${prior.label}).` : `${base}.`;
}

// Months of spending the current cash balance covers, or null if not computable.
export function runwayMonths(cashTotal: number, cf: { spending: number; status?: SectionStatus }): number | null {
  const monthlySpend = cf.spending / 3;
  return (cf.status ?? 'ok') === 'ok' && monthlySpend > 0 && cashTotal > 0 ? cashTotal / monthlySpend : null;
}

export function buildSignals(
  cashTotal: number,
  cf: { spending: number; savingsRate: number | null; status?: SectionStatus },
  yoyPct: number | null,
  prior?: { label: string; rate: number | null } | null,
): ReportSignal[] {
  const out: ReportSignal[] = [];
  const cfOk = (cf.status ?? 'ok') === 'ok';
  const runway = runwayMonths(cashTotal, cf);
  if (runway != null) {
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
      note: savingsNote(cf.savingsRate, prior),
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

// Four headline tiles. A tile whose inputs are missing shows "—" and says why —
// never a made-up zero.
export function buildKpis(i: {
  cashflow: Pick<ReportCashflow, 'saved' | 'savingsRate' | 'status'>;
  attribution: Attribution | null;
  runway: number | null;
  homeShare: number | null;
}): ReportKpi[] {
  const na = (label: string, why: string): ReportKpi => ({ label, value: '—', valueTone: 'none', note: why, noteTone: 'none' });
  const kpis: ReportKpi[] = [];
  const cf = i.cashflow;
  kpis.push(cf.status !== 'ok'
    ? na('Saved this quarter', cf.status === 'failed' ? 'Cash flow unavailable' : 'No transactions this quarter')
    : {
        label: 'Saved this quarter', value: fmtMoney(cf.saved), valueTone: cf.saved >= 0 ? 'up' : 'down',
        note: cf.savingsRate != null ? `${Math.round(cf.savingsRate * 100)}% of income` : 'No income recorded', noteTone: 'none',
      });
  const a = i.attribution;
  kpis.push(!a
    ? na('Market & other', 'Needs snapshots and cash flow')
    : {
        label: 'Market & other', value: fmtSigned(a.market), valueTone: a.market >= 0 ? 'up' : 'down',
        note: a.start ? `${a.market >= 0 ? '+' : '−'}${(Math.abs(a.market) / Math.abs(a.start) * 100).toFixed(1)}% of starting net worth` : 'Returns & other changes',
        noteTone: 'none',
      });
  kpis.push(i.runway == null
    ? na('Emergency runway', 'No cash or spending data')
    : {
        label: 'Emergency runway', value: `${i.runway.toFixed(1)} mo`, valueTone: 'none',
        note: i.runway < 6 ? 'Below a 6-month target' : 'At or above a 6-month target', noteTone: i.runway < 6 ? 'warn' : 'none',
      });
  kpis.push(i.homeShare == null
    ? na('Home equity share', 'Needs a net-worth snapshot')
    : { label: 'Home equity share', value: `${Math.round(i.homeShare * 100)}%`, valueTone: 'none', note: 'of net worth', noteTone: 'none' });
  return kpis;
}

// "In brief" bullets when the assistant isn't available: driver of the change,
// savings (vs. last quarter when known), and runway.
export function deterministicBrief(i: {
  quarterLabel: string; netWorth: number;
  netWorthChange: number | null; netWorthChangePct: number | null;
  attribution: Attribution | null;
  cashflow: Pick<ReportCashflow, 'savingsRate' | 'status'>;
  prior: { label: string; rate: number | null } | null;
  runway: number | null;
}): string[] {
  const out: string[] = [];
  const usd = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  if (i.netWorthChange != null && i.netWorthChangePct != null) {
    let s = `Net worth ${i.netWorthChange >= 0 ? 'rose' : 'fell'} ${usd(i.netWorthChange)} (${(Math.abs(i.netWorthChangePct) * 100).toFixed(1)}%) over the quarter to ${usd(i.netWorth)}`;
    const a = i.attribution;
    if (a) {
      const parts = [
        { name: 'savings', v: a.saved }, { name: 'home equity', v: a.home }, { name: 'market moves and other changes', v: a.market },
      ].sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
      if (Math.abs(parts[0].v) > 0) s += `, led by ${parts[0].name} (${fmtSigned(parts[0].v)})`;
    }
    out.push(s + '.');
  } else {
    out.push(`Your net worth closed ${i.quarterLabel} at ${usd(i.netWorth)}.`);
  }
  if (i.cashflow.status === 'ok' && i.cashflow.savingsRate != null) out.push(savingsNote(i.cashflow.savingsRate, i.prior));
  if (i.runway != null) {
    out.push(`Cash covers about ${i.runway.toFixed(1)} months of spending${i.runway < 6 ? ' — consider building toward 6.' : ', above the usual 6-month target.'}`);
  }
  return out;
}

// Turn the assistant's note into 2–4 bullets when it splits cleanly into
// sentences; otherwise keep its paragraphs.
export function splitBrief(note: string): string[] {
  const paras = note.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const sentences = paras.flatMap(p => p.split(/(?<=[a-z0-9%)”"][.!?])\s+(?=[A-Z$“"(])/)).map(s => s.trim()).filter(Boolean);
  return sentences.length >= 2 && sentences.length <= 4 ? sentences : paras;
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
  // Local verification switch: render the deterministic report without spawning
  // the Claude binary at all.
  if (process.env.KEVFIN_REPORT_NO_AI === '1') return null;
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
  const pw = priorWindow(w);

  const history = (getNetWorthHistory(100000) as Snapshot[])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  // Headline figures come from the period-END snapshot (not whatever is latest),
  // and the change is measured from a dated baseline we print on the report.
  const fig = computePeriodFigures(history, w);
  const netWorth = fig.endSnap?.net_worth ?? 0;
  const { change: netWorthChange, changePct: netWorthChangePct, yoyPct } = fig;

  const acct = buildAccounts(fig.startSnap?.date ?? null, fig.endSnap?.date ?? null);
  const [alloc, cashflow, priorCf] = await Promise.all([buildAllocation(), buildCashflow(w), buildCashflow(pw)]);
  const { buckets: taxBuckets, status: taxStatus } = buildTaxBuckets();
  const prior = priorCf.status === 'ok' && priorCf.savingsRate != null
    ? { label: pw.quarterLabel.split(' ')[0], rate: priorCf.savingsRate } : null;
  const signals = buildSignals(acct.cashTotal, cashflow, yoyPct, prior);
  const runway = runwayMonths(acct.cashTotal, cashflow);
  const today = now.toISOString().slice(0, 10);

  // What changed: end − start = saved + home-equity change + remainder ("market & other").
  const s = fig.startSnap, e = fig.endSnap;
  const attribution: Attribution | null =
    s && e && cashflow.status === 'ok' && typeof s.real_estate_total === 'number' && typeof e.real_estate_total === 'number'
      ? attributeChange({ start: s.net_worth, end: e.net_worth, saved: cashflow.saved, homeEquityDelta: e.real_estate_total - s.real_estate_total })
      : null;
  const homeShare = e && typeof e.real_estate_total === 'number' && e.net_worth > 0 ? e.real_estate_total / e.net_worth : null;

  const base: Omit<ReportModel, 'brief' | 'noteSource'> = {
    quarterLabel: w.quarterLabel,
    quarterShort: `Q${w.quarter}`,
    periodLabel: periodLabel(w),
    generatedAt: fmtDay(today),
    asOf: e ? fmtDay(e.date) : null,
    netWorth, netWorthChange, netWorthChangePct, yoyPct,
    deltaFrom: netWorthChange != null && s ? fmtDay(s.date) : null,
    trend: {
      points: monthEndSeries(history, w.periodEnd.slice(0, 7), 12),
      shadeKeys: quarterMonthKeys(w),
    },
    kpis: buildKpis({ cashflow, attribution, runway, homeShare }),
    attribution,
    startLabel: attribution && s ? fmtShort(s.date) : null,
    endLabel: attribution && e ? fmtShort(e.date) : null,
    accounts: acct.accounts, accountsStatus: acct.status, showChange: acct.showChange,
    allocation: alloc.slices, allocationStatus: alloc.status, allocationTotal: alloc.total,
    taxBuckets, taxStatus, cashflow, signals,
  };

  // Compact figures for the model to reason over (numbers only — no raw records).
  const cfOk = cashflow.status === 'ok';
  const summary =
    `Quarter: ${w.quarterLabel} (${periodLabel(w)}).\n` +
    `Net worth${e ? ` as of ${e.date}` : ''}: $${Math.round(netWorth).toLocaleString('en-US')}` +
    (netWorthChange != null ? `, change this quarter ${netWorthChange >= 0 ? '+' : ''}$${Math.round(netWorthChange).toLocaleString('en-US')}` : '') +
    (netWorthChangePct != null ? ` (${(netWorthChangePct * 100).toFixed(1)}%)` : '') +
    (s && netWorthChange != null ? ` since ${s.date}` : '') +
    (yoyPct != null ? `, year-over-year ${(yoyPct * 100).toFixed(1)}%` : ', year-over-year not available (insufficient history)') + '.\n' +
    (attribution ? `Change drivers: saved ${fmtSigned(attribution.saved)}, home equity ${fmtSigned(attribution.home)}, market & other ${fmtSigned(attribution.market)}.\n` : '') +
    (cfOk
      ? `Cash flow (spending includes mortgage payments): income $${Math.round(cashflow.income).toLocaleString('en-US')}, spending $${Math.round(cashflow.spending).toLocaleString('en-US')}, saved $${Math.round(cashflow.saved).toLocaleString('en-US')}` +
        (cashflow.savingsRate != null ? ` (${Math.round(cashflow.savingsRate * 100)}% savings rate)` : '') + '.\n'
      : 'Cash flow: not available for this quarter.\n') +
    (alloc.slices.length ? `Allocation (current): ${alloc.slices.map(x => `${x.label} ${x.pct.toFixed(0)}%`).join(', ')}.\n` : '') +
    `Liquid cash (current): $${Math.round(acct.cashTotal).toLocaleString('en-US')}.\n` +
    (acct.propertyCount ? `Real estate: ${acct.propertyCount} propert${acct.propertyCount === 1 ? 'y' : 'ies'}, equity $${Math.round(acct.reEquity).toLocaleString('en-US')}.\n` : '') +
    (taxBuckets.length ? `Tax treatment (current): ${taxBuckets.map(b => `${b.label} $${Math.round(b.value).toLocaleString('en-US')}`).join(', ')}.\n` : '') +
    (signals.length ? `Signals: ${signals.map(x => `${x.label} ${x.value}`).join('; ')}.` : '');

  const advisory = await aiAdvisory(summary, buildAdvisorySystemPrompt(w, now));
  const model: ReportModel = advisory?.note
    ? {
        ...base,
        brief: splitBrief(advisory.note),
        noteSource: 'assistant',
        marketView: advisory.marketView,
        taxActions: advisory.taxActions,
        estateActions: advisory.estateActions,
      }
    : {
        ...base,
        brief: deterministicBrief({
          quarterLabel: w.quarterLabel, netWorth, netWorthChange, netWorthChangePct, attribution, cashflow, prior, runway,
        }),
        noteSource: 'summary',
      };

  return renderReportHtml(model);
}

export { getReportWindow };
