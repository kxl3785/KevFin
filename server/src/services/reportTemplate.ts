// Pure renderer for the quarterly report. Takes a fully-computed model and
// returns a self-contained HTML document (inline CSS, no scripts, no external
// requests) in KevFin's "Ledger" statement style — pine + cool ivory, Georgia
// serif, hairline rules. Kept dependency-free and side-effect-free so it can be
// unit-tested and screenshotted with sample data.

export interface ReportAccount { name: string; org: string; balance: number }
export interface ReportGroup { name: string; subtotal: number; rows: ReportAccount[] }
export interface ReportSlice { label: string; pct: number }        // pct 0–100
export interface ReportBucket { label: string; value: number }
export interface ReportSignal { tag: string; tone: 'good' | 'watch' | 'neutral'; label: string; value: string; note: string }

export interface ReportModel {
  quarterLabel: string;      // "Q2 2026"
  periodLabel: string;       // "1 Apr – 30 Jun 2026"
  generatedAt: string;       // "8 Jul 2026"
  netWorth: number;
  netWorthChange: number | null;
  netWorthChangePct: number | null;  // fraction, e.g. 0.068
  yoyPct: number | null;             // fraction
  groups: ReportGroup[];
  allocation: ReportSlice[];
  cashflow: { income: number; spending: number; saved: number; savingsRate: number | null };
  taxBuckets: ReportBucket[];
  signals: ReportSignal[];
  analystNote: string;               // one or more paragraphs (plain text)
  noteSource: 'assistant' | 'summary';
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const money = (n: number) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
const signMoney = (n: number) => (n >= 0 ? '+' : '−') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = (f: number) => (f >= 0 ? '+' : '−') + (Math.abs(f) * 100).toFixed(1) + '%';

// Single-hue pine ramp for the (magnitude-ordered) allocation bar.
const RAMP = ['#2b4a3f', '#3d6a58', '#568a76', '#7aa896', '#a6c6b8', '#cfe0d7'];
const TONE = { good: '#2f7d5b', watch: '#b8863a', neutral: '#6a746e' };

function allocBar(slices: ReportSlice[]): string {
  const total = slices.reduce((s, d) => s + d.pct, 0) || 1;
  const segs = slices.map((d, i) =>
    `<span style="width:${(d.pct / total * 100).toFixed(2)}%;background:${RAMP[i % RAMP.length]}"></span>`).join('');
  const legend = slices.map((d, i) =>
    `<li><i style="background:${RAMP[i % RAMP.length]}"></i><span>${esc(d.label)}</span><b>${d.pct.toFixed(0)}%</b></li>`).join('');
  return `<div class="alloc-bar">${segs}</div><ul class="legend">${legend}</ul>`;
}

function accountsBlock(groups: ReportGroup[], netWorth: number, change: number | null): string {
  const gs = groups.map(g => {
    const rows = g.rows.map(r =>
      `<div class="acct-row"><span class="acct-name">${esc(r.name)}<em>${esc(r.org)}</em></span>` +
      `<span class="num">${money(r.balance)}</span></div>`).join('');
    return `<div class="acct-group"><div class="acct-head"><span>${esc(g.name)}</span>` +
      `<span class="num">${money(g.subtotal)}</span></div>${rows}</div>`;
  }).join('');
  const total = `<div class="acct-total"><span>Total net worth</span><span class="num">${money(netWorth)}` +
    (change != null ? ` <em class="${change >= 0 ? 'up' : 'down'}">${signMoney(change)}</em>` : '') + `</span></div>`;
  return gs + total;
}

function signalsBlock(signals: ReportSignal[]): string {
  if (!signals.length) return '';
  const cards = signals.map(s =>
    `<div class="sig"><div class="sig-top"><span class="sig-dot" style="background:${TONE[s.tone]}"></span>` +
    `<span class="sig-tag" style="color:${TONE[s.tone]}">${esc(s.tag)}</span></div>` +
    `<p class="sig-k">${esc(s.label)}</p><p class="sig-v">${esc(s.value)}</p><p class="sig-d">${esc(s.note)}</p></div>`).join('');
  return `<hr class="rule"><section><div class="h2row"><h2 class="h2">Signals &amp; inferences</h2>` +
    `<span class="h2note">derived from your data</span></div><div class="signals">${cards}</div></section>`;
}

export function renderReportHtml(m: ReportModel): string {
  const deltaLine = (m.netWorthChange != null && m.netWorthChangePct != null)
    ? `<p class="delta ${m.netWorthChange >= 0 ? 'up' : 'down'}">${m.netWorthChange >= 0 ? '▲' : '▼'} ${signMoney(m.netWorthChange)} &nbsp;·&nbsp; ${pct(m.netWorthChangePct)} this quarter</p>`
    : '';
  const side = [
    m.yoyPct != null ? `<div><dt>Year over year</dt><dd class="${m.yoyPct >= 0 ? 'up' : 'down'}">${pct(m.yoyPct)}</dd></div>` : '',
    `<div><dt>Saved this quarter</dt><dd class="up">${money(m.cashflow.saved)}</dd></div>`,
    m.cashflow.savingsRate != null ? `<div><dt>Savings rate</dt><dd>${Math.round(m.cashflow.savingsRate * 100)}%</dd></div>` : '',
  ].filter(Boolean).join('');

  const cf = m.cashflow;
  const taxRows = m.taxBuckets.map(b =>
    `<div><dt>${esc(b.label)}</dt><dd>${money(b.value)}</dd></div>`).join('');
  const noteParas = m.analystNote.split(/\n{2,}/).map(p => `<p>${esc(p.trim())}</p>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KevFin — ${esc(m.quarterLabel)} Report</title>
<style>
  :root{ --paper:#f3f4f0; --ink:#18201b; --muted:#6a746e; --accent:#2b4a3f; --sage:#7aa896;
    --line:#d7dbd2; --up:#2f7d5b; --down:#a8402f; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:#e2e4df; color:var(--ink);
    font-family:Georgia,"Iowan Old Style","Times New Roman",serif; -webkit-font-smoothing:antialiased; }
  .sheet{ max-width:780px; margin:0 auto; padding:40px 20px 70px; }
  .doc{ background:var(--paper); border:1px solid #e0e2da; border-radius:5px;
    box-shadow:0 26px 60px -34px rgba(20,40,32,.45); padding:52px 56px 40px; position:relative; }
  .sans{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .num{ font-variant-numeric:tabular-nums; }
  .up{ color:var(--up); } .down{ color:var(--down); }

  .head{ display:flex; justify-content:space-between; align-items:flex-start; gap:20px; }
  .logo{ font-weight:700; font-size:19px; color:var(--accent); letter-spacing:.02em; }
  .doc-t{ font-size:14px; font-style:italic; color:var(--muted); margin-top:2px; }
  .period{ text-align:right; font-size:12.5px; line-height:1.5; }
  .period .dim{ color:var(--muted); font-style:italic; }
  .rule-heavy{ border:0; border-top:2px solid var(--accent); margin:16px 0 26px; }
  .rule{ border:0; border-top:1px solid var(--line); margin:28px 0; }

  .label{ font-family:-apple-system,system-ui,sans-serif; text-transform:uppercase; letter-spacing:.16em;
    font-size:10px; color:var(--muted); margin:0 0 6px; }
  .hero{ display:flex; justify-content:space-between; align-items:flex-end; gap:28px; }
  .big{ font-size:50px; line-height:.95; margin:0; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .delta{ margin:12px 0 0; font-size:14px; }
  .side{ margin:0; display:grid; gap:9px; min-width:170px; }
  .side div{ display:flex; justify-content:space-between; gap:16px; border-bottom:1px solid #e0e3db; padding-bottom:6px; }
  .side dt{ font-size:12px; color:var(--muted); font-style:italic; }
  .side dd{ margin:0; font-size:14px; font-variant-numeric:tabular-nums; }

  .note{ margin:26px 0 0; background:#eef1ea; border:1px solid #dbe0d6; border-left:3px solid var(--accent);
    border-radius:8px; padding:20px 24px; }
  .note-head{ display:flex; align-items:center; gap:11px; margin-bottom:11px; }
  .note-badge{ font-family:-apple-system,system-ui,sans-serif; font-size:10px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); border:1px solid #b9c9c0; background:#f7f9f5;
    border-radius:999px; padding:4px 10px; font-weight:600; }
  .note-title{ font-size:14px; font-weight:700; }
  .note p{ margin:0 0 11px; font-size:14.5px; line-height:1.62; font-style:italic; color:#28312b; }
  .note p:last-child{ margin-bottom:0; }

  .h2row{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:14px; }
  .h2{ font-family:-apple-system,system-ui,sans-serif; font-size:13px; text-transform:uppercase;
    letter-spacing:.12em; color:var(--accent); font-weight:650; margin:0; }
  .h2note{ font-family:-apple-system,system-ui,sans-serif; font-size:11.5px; font-style:italic; color:var(--muted); }

  .acct-group{ margin-bottom:18px; }
  .acct-head{ display:flex; justify-content:space-between; align-items:baseline; border-bottom:1.5px solid var(--accent);
    padding-bottom:6px; margin-bottom:2px; font-weight:700; font-size:13px; }
  .acct-row{ display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:7px 0;
    border-bottom:1px dotted #cfd4cb; font-size:13.5px; }
  .acct-name{ display:flex; flex-direction:column; }
  .acct-name em{ font-style:italic; font-size:11px; color:var(--muted); margin-top:1px;
    font-family:-apple-system,system-ui,sans-serif; }
  .acct-total{ display:flex; justify-content:space-between; align-items:baseline; margin-top:14px;
    padding-top:11px; border-top:2px solid var(--accent); font-weight:700; font-size:15px; }
  .acct-total em{ font-style:normal; font-size:12px; margin-left:6px; }

  .cols{ display:grid; grid-template-columns:1fr 1fr; gap:40px; }
  .alloc-bar{ display:flex; height:22px; border-radius:3px; overflow:hidden; }
  .alloc-bar span{ height:100%; }
  .legend{ list-style:none; margin:14px 0 0; padding:0; display:grid; grid-template-columns:1fr 1fr;
    gap:7px 18px; font-size:12.5px; font-family:-apple-system,system-ui,sans-serif; }
  .legend li{ display:flex; align-items:center; gap:8px; }
  .legend i{ width:10px; height:10px; border-radius:2px; flex:none; }
  .legend b{ margin-left:auto; font-variant-numeric:tabular-nums; }

  .flowbar{ display:flex; align-items:center; justify-content:center; gap:22px; margin:6px 0 0;
    background:#ecefe8; border:1px solid #dde0d8; border-radius:8px; padding:16px 20px; }
  .flowbar > div{ display:flex; flex-direction:column; align-items:center; gap:4px; }
  .flowk{ font-family:-apple-system,system-ui,sans-serif; font-size:11px; text-transform:uppercase;
    letter-spacing:.1em; color:var(--muted); }
  .flowv{ font-size:19px; font-variant-numeric:tabular-nums; }
  .flowop{ font-size:22px; color:#9aa29b; }

  .stats{ margin:0; display:grid; gap:9px; }
  .stats div{ display:flex; justify-content:space-between; align-items:baseline; }
  .stats dt{ font-style:italic; color:var(--muted); font-size:13px; }
  .stats dd{ margin:0; font-size:15px; font-variant-numeric:tabular-nums; }

  .signals{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .sig{ border:1px solid var(--line); border-radius:8px; padding:14px 16px; background:#f7f8f4; }
  .sig-top{ display:flex; align-items:center; gap:7px; margin-bottom:9px; }
  .sig-dot{ width:7px; height:7px; border-radius:50%; flex:none; }
  .sig-tag{ font-family:-apple-system,system-ui,sans-serif; font-size:10.5px; letter-spacing:.1em;
    text-transform:uppercase; font-weight:700; }
  .sig-k{ font-family:-apple-system,system-ui,sans-serif; font-size:11px; letter-spacing:.06em;
    text-transform:uppercase; color:var(--muted); margin:0 0 5px; }
  .sig-v{ font-size:22px; margin:0 0 6px; font-variant-numeric:tabular-nums; }
  .sig-d{ font-family:-apple-system,system-ui,sans-serif; font-size:12px; line-height:1.5; color:#55605a; margin:0; }

  .foot{ margin-top:34px; padding-top:16px; border-top:1px solid var(--line);
    font-family:-apple-system,system-ui,sans-serif; }
  .foot-row{ display:flex; justify-content:space-between; gap:16px; font-size:11px; color:#8a938c; }
  .disc{ font-size:10px; line-height:1.55; color:#9aa29b; margin:10px 0 0; font-style:italic; }

  @media (max-width:640px){
    .doc{ padding:32px 22px; }
    .hero,.cols,.signals{ grid-template-columns:1fr; }
    .hero{ display:grid; }
    .big{ font-size:38px; }
    .signals{ gap:10px; } .foot-row{ flex-direction:column; gap:4px; }
  }
  @media print{ body{ background:#fff; } .doc{ box-shadow:none; border:0; } .sheet{ padding:0; } }
</style></head>
<body><div class="sheet"><div class="doc">

  <div class="head">
    <div><div class="logo">KevFin</div><div class="doc-t">Quarterly Statement of Net Worth</div></div>
    <div class="period"><div>${esc(m.quarterLabel)}</div><div class="dim">${esc(m.periodLabel)}</div></div>
  </div>
  <hr class="rule-heavy">

  <div class="hero">
    <div><p class="label">Total net worth</p><p class="big">${money(m.netWorth)}</p>${deltaLine}</div>
    <dl class="side">${side}</dl>
  </div>

  <section class="note">
    <div class="note-head">
      <span class="note-badge">${m.noteSource === 'assistant' ? '✦ Local assistant' : '✦ Summary'}</span>
      <span class="note-title">Analyst's note</span>
    </div>
    ${noteParas}
  </section>

  <hr class="rule">
  <section>
    <div class="h2row"><h2 class="h2">Accounts</h2></div>
    ${accountsBlock(m.groups, m.netWorth, m.netWorthChange)}
  </section>

  <hr class="rule">
  <div class="cols">
    <section>
      <div class="h2row"><h2 class="h2">Asset allocation</h2></div>
      ${m.allocation.length ? allocBar(m.allocation) : '<p class="sig-d">No investment holdings found.</p>'}
    </section>
    <section>
      <div class="h2row"><h2 class="h2">By tax treatment</h2></div>
      <dl class="stats">${taxRows || '<div><dt>No data</dt><dd>—</dd></div>'}</dl>
    </section>
  </div>

  <hr class="rule">
  <section>
    <div class="h2row"><h2 class="h2">Cash flow this quarter</h2></div>
    <div class="flowbar">
      <div><span class="flowk">Income</span><span class="flowv">${money(cf.income)}</span></div>
      <span class="flowop">−</span>
      <div><span class="flowk">Spending</span><span class="flowv">${money(cf.spending)}</span></div>
      <span class="flowop">=</span>
      <div><span class="flowk">Saved</span><span class="flowv up">${money(cf.saved)}${cf.savingsRate != null ? ` · ${Math.round(cf.savingsRate * 100)}%` : ''}</span></div>
    </div>
  </section>

  ${signalsBlock(m.signals)}

  <footer class="foot">
    <div class="foot-row">
      <span>Generated ${esc(m.generatedAt)} · KevFin, self-hosted</span>
      <span>Rendered locally — your data never left this machine.</span>
    </div>
    <p class="disc">This statement is generated from your own data and is for personal information only.
    It is not investment, tax, or legal advice. Figures are point-in-time estimates drawn from connected
    accounts, look-through holdings, and property valuations, and may differ from official statements.</p>
  </footer>

</div></div></body></html>`;
}
