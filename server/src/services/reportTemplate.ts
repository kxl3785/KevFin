// Pure renderer for the quarterly report. Takes a fully-computed model and
// returns a self-contained HTML document (inline CSS + inline SVG; the only script
// is a single inline window.print() handler on the "Save as PDF" button — no
// external requests, nothing leaves the machine). Layout follows the "story
// order" statement: hero → KPIs → in brief → what changed → where the money is →
// cash flow → signals → looking ahead. Kept dependency-free and side-effect-free so
// it can be unit-tested and screenshotted with sample data. PDF export is native
// browser print-to-PDF, driven by the @media print rules below.
import {
  esc, C, RAMP, fmtMoney, fmtSigned, trendSvg, waterfallSvg, donutSvg, groupedBarsSvg, fmtK,
  type MonthPoint, type Attribution,
} from '../util/reportCharts.js';

export interface ReportAccount { name: string; org: string; balance: number; change?: number | null }
export interface ReportSlice { label: string; pct: number }        // pct 0–100
export interface ReportBucket { label: string; value: number }
export interface ReportSignal { tag: string; tone: 'good' | 'watch' | 'neutral'; label: string; value: string; note: string }
export interface ReportKpi {
  label: string; value: string; valueTone: 'up' | 'down' | 'none';
  note: string; noteTone: 'warn' | 'none';
}

// 'ok' = computed; 'empty' = computed but genuinely nothing there; 'failed' = the
// section errored, so we must not present zeros as fact.
export type SectionStatus = 'ok' | 'empty' | 'failed';

export interface ReportCashflow {
  income: number; spending: number; saved: number; savingsRate: number | null; status: SectionStatus;
  months: { label: string; income: number; spending: number }[];
  categories: { label: string; amount: number }[];   // top spending categories, desc
  other: number;                                     // spending outside `categories`
}

export interface ReportModel {
  quarterLabel: string;      // "Q2 2026"
  quarterShort: string;      // "Q2"
  periodLabel: string;       // "Apr 1 – Jun 30, 2026"
  generatedAt: string;       // "Jul 8, 2026"
  asOf: string | null;       // date of the snapshot the hero value comes from
  netWorth: number;
  netWorthChange: number | null;
  netWorthChangePct: number | null;  // fraction, e.g. 0.068
  deltaFrom: string | null;          // date of the baseline snapshot the change is measured from
  yoyPct: number | null;             // fraction; null = not enough history (line omitted)
  trend: { points: MonthPoint[]; shadeKeys: string[] };
  kpis: ReportKpi[];
  brief: string[];                   // "In brief" bullets
  noteSource: 'assistant' | 'summary';
  // Waterfall: null when start/end snapshots or cash flow are unavailable.
  attribution: Attribution | null;
  startLabel: string | null;         // "Jun 30"
  endLabel: string | null;           // "Sep 30"
  // Accounts, allocation and tax buckets are live holdings (no historical
  // per-account data exists), so they're labelled "current" rather than period-end.
  accounts: ReportAccount[];
  accountsStatus: SectionStatus;
  showChange: boolean;               // per-account change column available
  allocation: ReportSlice[];
  allocationStatus: SectionStatus;
  allocationTotal: number | null;
  taxBuckets: ReportBucket[];
  taxStatus: SectionStatus;
  cashflow: ReportCashflow;
  signals: ReportSignal[];
  // Forward-looking advisory, authored by the local assistant. Omitted entirely
  // when the assistant is unavailable — these can't be derived deterministically.
  marketView?: string[];
  taxActions?: { action: string; why: string }[];
  estateActions?: { action: string; why: string }[];
}

const money = fmtMoney;
const signMoney = fmtSigned;
const pct = (f: number) => (f >= 0 ? '+' : '−') + (Math.abs(f) * 100).toFixed(1) + '%';
const sign = (n: number) => (n >= 0 ? 'up' : 'down');

const NA_FAILED = 'Not available for this report — this section could not be generated.';
function unavailable(status: SectionStatus, emptyText: string): string {
  return `<p class="na">${status === 'failed' ? NA_FAILED : esc(emptyText)}</p>`;
}

// Largest accounts first; anything past `max` rows collapses into one
// "Other accounts (N)" row whose change is only shown when every member has one.
export function collapseAccounts(rows: ReportAccount[], max = 8): ReportAccount[] {
  const sorted = rows.slice().sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  if (sorted.length <= max) return sorted;
  const keep = sorted.slice(0, max - 1), rest = sorted.slice(max - 1);
  const allHave = rest.every(r => typeof r.change === 'number');
  return [...keep, {
    name: `Other accounts (${rest.length})`, org: '—',
    balance: rest.reduce((s, r) => s + r.balance, 0),
    change: allHave ? rest.reduce((s, r) => s + (r.change as number), 0) : null,
  }];
}

// --- blocks --------------------------------------------------------------------

function kpiBlock(kpis: ReportKpi[]): string {
  const tiles = kpis.map(k =>
    `<div class="kpi"><p class="kpi-k">${esc(k.label)}</p>` +
    `<p class="kpi-v${k.valueTone !== 'none' ? ' ' + k.valueTone : ''}">${esc(k.value)}</p>` +
    `<p class="kpi-n${k.noteTone === 'warn' ? ' warn' : ''}">${esc(k.note)}</p></div>`).join('');
  return `<div class="kpis">${tiles}</div>`;
}

function waterfallBlock(m: ReportModel): string {
  const a = m.attribution;
  const head = `<h2>What changed this quarter</h2>`;
  if (!a || !m.startLabel || !m.endLabel) {
    return `<section>${head}<p class="na">Not available for this quarter — it needs balance snapshots at both ends of the quarter and cash-flow data.</p></section>`;
  }
  const input = {
    startLabel: m.startLabel, endLabel: m.endLabel, start: a.start, end: a.end,
    steps: [
      { label: 'Saved', amount: a.saved, title: 'Income minus spending (including mortgage payments) for the quarter.' },
      { label: 'Home equity', sublabel: 'value + mortgage paydown', amount: a.home, title: 'Change in property value less mortgage balance between the two snapshots.' },
      { label: 'Market & other', amount: a.market, title: 'The remainder: investment returns, untracked transfers and rounding.' },
    ],
  };
  const w = waterfallSvg(input);
  // Phones get a narrower canvas with wrapped labels (CSS swaps the two at 640px).
  const wCompact = waterfallSvg(input, { compact: true });
  const sub = `From ${money(a.start)} on ${esc(m.startLabel)} to ${money(a.end)} on ${esc(m.endLabel)}` +
    (w.truncated ? ` · axis starts at ${fmtK(w.axisFloor)}` : '');
  return `<section>${head}<p class="sub">${sub}</p><figure class="fig">${w.svg}${wCompact.svg}</figure>` +
    `<p class="sub small">“Market &amp; other” is the remainder after savings and home equity: investment returns, untracked transfers and rounding.</p></section>`;
}

function accountsTable(m: ReportModel): string {
  if (m.accountsStatus !== 'ok' || !m.accounts.length) return unavailable(m.accountsStatus, 'No accounts found.');
  const rows = collapseAccounts(m.accounts);
  const head = `<tr><th>Account</th><th class="col-org">Institution</th><th class="r">Balance</th>` +
    (m.showChange ? `<th class="r">${esc(m.quarterShort)} change</th>` : '') + `</tr>`;
  const body = rows.map(r =>
    `<tr><td>${esc(r.name)}${r.org && r.org !== '—' ? `<span class="acct-org">${esc(r.org)}</span>` : ''}</td><td class="mut col-org">${esc(r.org)}</td><td class="r num">${money(r.balance)}</td>` +
    (m.showChange
      ? (typeof r.change === 'number'
          ? (Math.round(r.change) === 0
              ? `<td class="r num mut">$0</td>`
              : `<td class="r num ${sign(r.change)}">${signMoney(r.change)}</td>`)
          : `<td class="r num mut">—</td>`)
      : '') + `</tr>`).join('');
  return `<table class="acct"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function allocationBlock(m: ReportModel): string {
  if (m.allocationStatus !== 'ok' || !m.allocation.length) return unavailable(m.allocationStatus, 'No investment holdings found.');
  const legend = m.allocation.map((d, i) =>
    `<li><i style="background:${RAMP[i % RAMP.length]}"></i><span>${esc(d.label)} · ${d.pct.toFixed(0)}%</span></li>`).join('');
  return `<div class="donutrow">${donutSvg(m.allocation, 'Allocated', m.allocationTotal != null ? fmtK(m.allocationTotal) : '—')}` +
    `<ul class="legend">${legend}</ul></div>`;
}

// What the donut's total actually measures (getAllocation().total): brokerage and
// retirement holdings + home equity not excluded from allocation + manual assets.
// Bank cash and credit balances are not part of it, so it sits below net worth.
function allocationNote(m: ReportModel): string {
  if (m.allocationStatus !== 'ok' || !m.allocation.length) return '';
  const of = m.allocationTotal != null ? ` (${fmtK(m.allocationTotal)} in all)` : '';
  return `<p class="sub">The allocation chart covers investment accounts, home equity and manual assets${of}. ` +
    `Bank cash, credit cards and any property excluded from allocation are not counted, so it is lower than net worth above.</p>`;
}

function taxBlock(m: ReportModel): string {
  if (m.taxStatus !== 'ok' || !m.taxBuckets.length) return unavailable(m.taxStatus, 'No taxable or retirement balances found.');
  const total = m.taxBuckets.reduce((s, b) => s + b.value, 0) || 1;
  const segs = m.taxBuckets.map((b, i) =>
    `<div style="width:${(b.value / total * 100).toFixed(2)}%;background:${RAMP[i % RAMP.length]}"></div>`).join('');
  const labels = m.taxBuckets.map((b, i) =>
    `<li><i style="background:${RAMP[i % RAMP.length]}"></i><span>${esc(b.label)} · ${money(b.value)} (${(b.value / total * 100).toFixed(0)}%)</span></li>`).join('');
  const aria = 'Tax treatment: ' + m.taxBuckets.map(b => `${b.label} ${money(b.value)}`).join(', ');
  return `<div class="stack" role="img" aria-label="${esc(aria)}">${segs}</div><ul class="legend tight">${labels}</ul>`;
}

function cashflowBlock(m: ReportModel): string {
  const cf = m.cashflow;
  const head = `<h2>Cash flow</h2>`;
  if (cf.status !== 'ok') {
    return `<section>${head}${unavailable(cf.status, 'Not available for this quarter — no income or spending was recorded.')}</section>`;
  }
  const rate = cf.savingsRate != null ? ` (${Math.round(cf.savingsRate * 100)}%)` : '';
  const sub = `Income ${money(cf.income)} − spending ${money(cf.spending)} = saved ${money(cf.saved)}${rate} · spending includes mortgage payments`;
  const chart = groupedBarsSvg(cf.months.map(x => ({ label: x.label, a: x.income, b: x.spending })), 'Income', 'Spending');
  const max = Math.max(...cf.categories.map(c => c.amount), cf.other, 1);
  const bar = (label: string, amount: number, fill: string) =>
    `<div class="hbar"><span>${esc(label)}</span><span class="track"><i style="width:${Math.max(1, amount / max * 100).toFixed(1)}%;background:${fill}"></i></span><span class="r num">${money(amount)}</span></div>`;
  const cats = cf.categories.map(c => bar(c.label, c.amount, C.sand)).join('') +
    (cf.other > 0 ? bar('Everything else', cf.other, C.rule) : '');
  return `<section>${head}<p class="sub">${esc(sub)}</p><div class="cols"><figure class="fig">${chart}</figure>` +
    `<div class="hbars"><p class="bold">Where it went</p>${cats || '<p class="na">No spending categories recorded.</p>'}</div></div></section>`;
}

const CHIP = { good: ['Healthy', 'chip-good'], watch: ['Watch', 'chip-watch'], neutral: ['Neutral', 'chip-neutral'] } as const;

function signalsBlock(signals: ReportSignal[]): string {
  if (!signals.length) return '';
  const cards = signals.map(s => {
    const [label, cls] = CHIP[s.tone];
    return `<div class="sig"><div class="sig-top"><span class="sig-k">${esc(s.label)}</span><span class="chip ${cls}">${label}</span></div>` +
      `<p class="sig-v">${esc(s.value)}</p><p class="sig-d">${esc(s.note)}</p></div>`;
  }).join('');
  return `<section><h2>Signals</h2><div class="sigs">${cards}</div></section>`;
}

function aheadBlock(m: ReportModel): string {
  const col = (title: string, inner: string) => `<div><p class="ahead-h">${esc(title)}</p>${inner}</div>`;
  const cols: string[] = [];
  if (m.marketView?.length) cols.push(col('Market view', `<ul class="bullets">${m.marketView.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`));
  const items = (xs: { action: string; why: string }[]) =>
    xs.map(t => `<div class="item"><p class="item-a">${esc(t.action)}</p><p class="item-w">${esc(t.why)}</p></div>`).join('');
  if (m.taxActions?.length) cols.push(col('Tax-aware actions', items(m.taxActions)));
  if (m.estateActions?.length) cols.push(col('Estate and legacy', items(m.estateActions)));
  if (!cols.length) return '';
  return `<section><h2>Looking ahead</h2><p class="sub">Written by your local assistant · general information, not advice</p>` +
    `<div class="ahead n${cols.length}">${cols.join('')}</div></section>`;
}

export function renderReportHtml(m: ReportModel): string {
  const deltaLine = (m.netWorthChange != null && m.netWorthChangePct != null)
    ? `<p class="delta"><span class="${sign(m.netWorthChange)} bold nw">${m.netWorthChange >= 0 ? '▲' : '▼'} ${money(Math.abs(m.netWorthChange))} (${pct(m.netWorthChangePct)})</span> ` +
      `<span class="mut">this quarter${m.deltaFrom ? `, from <span class="nw">${esc(m.deltaFrom)}</span>` : ''}</span></p>`
    : '';
  const yoyLine = m.yoyPct != null ? `<p class="yoy mut">${pct(m.yoyPct)} vs. a year ago</p>` : '';
  const trend = trendSvg(m.trend.points, m.trend.shadeKeys, m.quarterShort);
  const trendFig = trend
    ? `<figure class="fig">${trend}<figcaption>Net worth, last ${m.trend.points.length} months</figcaption></figure>`
    : `<p class="na">Not enough history for a trend chart.</p>`;

  const briefItems = m.brief.length > 1 || m.brief.length === 0
    ? `<ul>${m.brief.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`
    : `<p>${esc(m.brief[0])}</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KevFin — ${esc(m.quarterLabel)} Report</title>
<style>
  :root{ --paper:#fbfbf8; --ink:#1d2420; --muted:#5f6862; --rule:#d9ddd5; --pine:#2c4a3e; --sage:#7fa38b;
    --sand:#c9a35a; --slate:#6d7f96; --up:#2f7d4f; --down:#b0473c; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:#e8eae4; color:var(--ink); -webkit-font-smoothing:antialiased;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; }
  .sheet{ max-width:816px; margin:0 auto; padding:32px 16px 70px; }
  .doc{ background:var(--paper); border:1px solid #dfe2da; border-radius:6px;
    box-shadow:0 26px 60px -34px rgba(20,40,32,.45); padding:48px 48px 40px; display:flex; flex-direction:column; gap:28px; }
  .serif,h1,h2,.big{ font-family:Georgia,"Times New Roman",serif; }
  .num{ font-variant-numeric:tabular-nums; }
  .up{ color:var(--up); } .down{ color:var(--down); } .mut{ color:var(--muted); } .bold{ font-weight:700; }
  .r{ text-align:right; }
  p{ margin:0; }
  .chart{ width:100%; height:auto; display:block; }
  .fig{ margin:0; } .fig figcaption{ font-size:12px; color:var(--muted); margin-top:2px; }
  .na{ font-size:13px; font-style:italic; color:var(--muted); }

  .head{ display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid var(--pine); padding-bottom:14px; gap:16px; }
  .brand{ font-size:13px; font-weight:700; letter-spacing:1.5px; color:var(--pine); }
  h1{ margin:4px 0 0; font-size:30px; font-weight:600; line-height:1.15; }
  .titlebox{ flex:1 1 auto; min-width:0; }
  .nw{ white-space:nowrap; }
  .period{ text-align:right; flex:none; white-space:nowrap; } .period .q{ font-size:18px; font-weight:700; } .period .d{ margin-top:2px; font-size:13px; color:var(--muted); }

  .hero{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; align-items:center; }
  .hero .k{ font-size:13px; color:var(--muted); }
  .big{ margin:6px 0 0; font-size:52px; font-weight:600; letter-spacing:-1px; line-height:1.05; font-variant-numeric:tabular-nums; }
  .delta{ margin-top:6px; font-size:15px; } .yoy{ margin-top:4px; font-size:14px; }

  .kpis{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
  .kpi{ border:1px solid var(--rule); border-radius:10px; padding:12px 14px; }
  .kpi-k{ font-size:12px; color:var(--muted); }
  .wf-compact{ display:none; }
  .kpi-v{ margin-top:4px; font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
  .kpi-n{ margin-top:2px; font-size:12px; color:var(--muted); }
  .kpi-n.warn{ color:#8a5a14; font-weight:600; }

  .brief{ background:#eef3ef; border-radius:12px; padding:18px 22px; }
  .brief-h{ display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:13px; font-weight:700; color:var(--pine); }
  .badge{ font-size:11px; letter-spacing:.06em; text-transform:uppercase; font-weight:600; border:1px solid #b9c9c0;
    background:#f7f9f5; border-radius:999px; padding:2px 9px; }
  .brief ul{ margin:0; padding-left:18px; font-size:15px; line-height:1.6; }
  .brief p{ font-size:15px; line-height:1.6; }

  h2{ margin:0 0 4px; font-size:22px; font-weight:600; }
  .sub{ font-size:13px; color:var(--muted); margin:0 0 12px; } .sub.small{ font-size:12px; margin:8px 0 0; }
  .sub + .sub{ margin-top:-6px; }
  h2 + .sigs, h2 + .ahead{ margin-top:12px; }

  .cols{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:28px; }
  .donutrow{ display:flex; flex-wrap:wrap; gap:12px 18px; align-items:center; } .donutrow .donut{ width:140px; flex:none; }
  .legend{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; font-size:13px; }
  .legend.tight{ margin-top:10px; }
  .legend li{ display:flex; align-items:center; gap:7px; white-space:nowrap; }
  .legend i{ width:10px; height:10px; flex:none; border-radius:2px; display:inline-block; }
  .stack{ display:flex; height:22px; border-radius:6px; overflow:hidden; }
  .h3{ font-size:13px; font-weight:700; margin:0 0 8px; }

  table.acct{ width:100%; border-collapse:collapse; margin-top:20px; font-size:14px; }
  .acct th{ color:var(--muted); font-size:12px; text-align:left; padding:6px 0; border-bottom:1px solid var(--rule); font-weight:600; white-space:nowrap; }
  .acct td.num, .acct th.r{ padding-left:12px; white-space:nowrap; }
  .acct-org{ display:none; font-size:12px; color:var(--muted); margin-top:1px; }
  .acct th.r{ text-align:right; }
  .acct td{ padding:7px 0; border-bottom:1px solid #eceee9; }
  .acct tr:last-child td{ border-bottom:0; }
  .acct td.r{ text-align:right; }

  .hbars{ display:flex; flex-direction:column; gap:7px; font-size:13px; }
  .hbar{ display:grid; grid-template-columns:104px minmax(0,1fr) 64px; gap:8px; align-items:center; }
  .hbar .track{ display:block; } .hbar .track i{ display:block; height:10px; }

  .sigs{ display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }
  .sig{ border:1px solid var(--rule); border-radius:10px; padding:14px 12px; }
  .sig-top{ display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:4px 8px; }
  .sig-k{ font-size:13px; font-weight:700; }
  .chip{ font-size:11px; font-weight:700; padding:2px 7px; border-radius:10px; white-space:nowrap; }
  .chip-good{ color:#1f5e3a; background:#dcebe1; } .chip-watch{ color:#7a5212; background:#f3e6c9; } .chip-neutral{ color:#3d4a42; background:#e6e9e3; }
  .sig-v{ margin-top:6px; font-size:19px; font-weight:700; font-variant-numeric:tabular-nums; }
  .sig-d{ margin-top:4px; font-size:13px; color:var(--muted); }

  .ahead{ display:grid; gap:18px; font-size:13px; line-height:1.55; }
  .ahead.n1{ grid-template-columns:1fr; } .ahead.n2{ grid-template-columns:repeat(2,minmax(0,1fr)); } .ahead.n3{ grid-template-columns:repeat(3,minmax(0,1fr)); }
  .ahead-h{ font-weight:700; color:var(--pine); margin-bottom:6px; }
  .bullets{ margin:0; padding-left:16px; display:grid; gap:8px; }
  .item{ margin-bottom:10px; } .item-a{ font-weight:600; } .item-w{ color:var(--muted); margin-top:2px; }

  .foot{ margin-top:auto; border-top:1px solid var(--rule); padding-top:12px; font-size:12px; color:var(--muted); line-height:1.5; }
  .foot .disc{ margin-top:6px; font-style:italic; }

  /* Below ~860px a 4-up KPI row leaves ~110px of text width per tile, so labels wrap. */
  @media screen and (max-width:860px){
    .kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  }
  @media (max-width:640px){
    .sheet{ padding:12px 8px 44px; }
    .doc{ padding:28px 18px 28px; gap:24px; }
    .head{ flex-direction:column; align-items:flex-start; gap:8px; } .period{ text-align:left; }
    h1{ font-size:25px; }
    .hero,.cols{ grid-template-columns:1fr; gap:20px; }
    .big{ font-size:40px; }
    .kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }
    .sigs{ grid-template-columns:1fr; }
    .ahead.n2,.ahead.n3{ grid-template-columns:1fr; }
    .donutrow{ flex-direction:column; align-items:flex-start; }
    .brief{ padding:16px 16px; }
    .wf-wide{ display:none; } .wf-compact{ display:block; }
    /* Institution moves under the account name; the column goes away. */
    .col-org{ display:none; }
    .acct-org{ display:block; }
    table.acct{ font-size:13px; }
    .acct td{ vertical-align:top; }
  }
  .pdf-btn{ position:fixed; bottom:22px; right:22px; z-index:20; cursor:pointer;
    display:inline-flex; align-items:center; gap:7px; font-weight:600; font-size:13px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    color:#fff; background:var(--pine); border:0; border-radius:9px; padding:10px 15px;
    box-shadow:0 8px 22px -8px rgba(20,40,32,.55); }
  .pdf-btn:hover{ background:#213a31; }
  .pdf-btn:focus-visible{ outline:2px solid #fff; outline-offset:2px; }
  .pdf-btn svg{ width:15px; height:15px; }
  /* Without side margin to sit in, the button joins the page flow above the header. */
  @media screen and (max-width:960px){
    .pdf-btn{ position:static; display:flex; width:max-content; margin:12px 16px 0 auto; box-shadow:none; }
  }
  @media screen and (max-width:640px){ .pdf-btn{ margin-right:8px; padding:9px 13px; font-size:12.5px; } }

  @media print{
    /* Keep colors (chart fills, chips, tints) in the PDF. */
    html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    @page{ margin:10mm; }
    body{ background:#fff; }
    /* 2px of side padding keeps the outermost card borders off the clip edge. */
    .sheet{ padding:0 2px; max-width:none; }
    .doc{ box-shadow:none; border:0; border-radius:0; padding:0; gap:14px; }
    h2{ font-size:20px; }
    .big{ font-size:46px; }
    /* Slightly tighter than screen so the statement lands on two pages. */
    .wf-wide{ max-width:460px; margin:0 auto; }
    .donutrow .donut{ width:120px; }
    .sub{ break-inside:avoid; page-break-inside:avoid; }
    .fig + .sub{ break-before:avoid; page-break-before:avoid; }
    /* The footnote under a chart must not chain the next section's heading to it. */
    .sub.small{ break-after:auto; page-break-after:auto; }
    .pdf-btn{ display:none !important; }
    /* Only small atomic blocks stay whole; long sections flow across pages. */
    .brief, .kpi, .kpis, .sig, .fig, .chart, .item, .hero, .head, tr, .hbar, .donutrow, .stack, .cols, .foot{ break-inside:avoid; page-break-inside:avoid; }
    h2, .sub, .h3, .ahead-h, thead{ break-after:avoid; page-break-after:avoid; }
    .acct th{ break-after:avoid; }
  }
</style></head>
<body>
<button class="pdf-btn" type="button" onclick="window.print()" title="Save or print this report as a PDF" aria-label="Save this report as a PDF">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>
  </svg>
  Save as PDF
</button>
<div class="sheet"><div class="doc">

  <header class="head">
    <div class="titlebox"><p class="brand">KEVFIN</p><h1>Quarterly statement of net worth</h1></div>
    <div class="period"><p class="q">${esc(m.quarterLabel)}</p><p class="d nw">${esc(m.periodLabel)}</p></div>
  </header>

  <div class="hero">
    <div>
      <p class="k">Net worth${m.asOf ? ` · balances as of ${esc(m.asOf)}` : ''}</p>
      <p class="big">${money(m.netWorth)}</p>
      ${deltaLine}${yoyLine}
    </div>
    ${trendFig}
  </div>

  ${kpiBlock(m.kpis)}

  <section class="brief">
    <div class="brief-h"><span>In brief</span><span class="badge">${m.noteSource === 'assistant' ? '✦ Local assistant' : '✦ Summary'}</span></div>
    ${briefItems}
  </section>

  ${waterfallBlock(m)}

  <section>
    <h2>Where your money is</h2>
    <p class="sub">Current holdings, as of ${esc(m.generatedAt)}</p>
    ${allocationNote(m)}
    <div class="cols">
      <div>${allocationBlock(m)}</div>
      <div><p class="h3">By tax treatment</p>${taxBlock(m)}</div>
    </div>
    ${accountsTable(m)}
  </section>

  ${cashflowBlock(m)}

  ${signalsBlock(m.signals)}

  ${aheadBlock(m)}

  <footer class="foot">
    <div>Generated ${esc(m.generatedAt)} · KevFin, self-hosted · rendered locally, your data never left this machine.${m.asOf ? ` Net worth and cash flow as of ${esc(m.asOf)}; accounts, allocation and tax sections are current holdings.` : ''}</div>
    <p class="disc">This statement is generated from your own data and is for personal information only.
    It is not investment, tax, or legal advice. Figures are point-in-time estimates drawn from connected
    accounts, look-through holdings, and property valuations, and may differ from official statements.</p>
  </footer>

</div></div></body></html>`;
}
