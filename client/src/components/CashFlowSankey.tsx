import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import MerchantIcon from './MerchantIcon.tsx';
import CategoryPicker, { type PickerGroup } from './CategoryPicker.tsx';
import { openTxnDetail } from './TransactionDetail.tsx';

type NodeFilter =
  | { type: 'income' }
  | { type: 'source'; value: string }
  | { type: 'group'; value: string }
  | { type: 'category'; value: string }
  | { type: 'savings' };
interface SankeyNode { name: string; color: string; col: number; kind: string; filter: NodeFilter }
interface SankeyLink { source: number; target: number; value: number }
interface CashFlow {
  range: string; label: string;
  income: number; spending: number; savings: number;
  nodes: SankeyNode[]; links: SankeyLink[];
}
interface CashTxn { id: string; date: string; payee: string; merchant: string; account: string; category: string; suggested: string; amount: number; description: string; memo: string; postedAt: number; transactedAt: number | null }
interface CashTxnResp { label: string; total: number; txns: CashTxn[] }
const filterValue = (f: NodeFilter): string => ('value' in f ? f.value : '');

const RANGES = [
  { key: '1m', label: 'This month' },
  { key: '3m', label: '3 months' },
  { key: '6m', label: '6 months' },
  { key: 'ytd', label: 'YTD' },
  { key: '12m', label: '12 months' },
  { key: 'all', label: 'All time' },
];

const TEXT = '#e8eaf0', MUTED = '#7b7f95';
const NODE_W = 13, NODE_PAD = 10, MARGIN_X = 150, MARGIN_Y = 14;

interface PlacedNode extends SankeyNode { idx: number; value: number; x: number; y: number; h: number; order: number }

// Lay the graph out left→right using the backend-provided `col` for each node, so
// income sources sit on the left, the Income hub in the middle, and spending /
// savings flow out to the right. Unlike recharts' Sankey we honour `col` exactly
// (recharts right-aligns any sink, which dumped Savings into the leaf column and
// made links swoop across the whole chart). A few barycenter passes order nodes
// within each column to minimise ribbon crossings, à la d3-sankey.
function layout(nodes: SankeyNode[], links: SankeyLink[], W: number, H: number) {
  const N = nodes.length;
  const inSum = new Array(N).fill(0), outSum = new Array(N).fill(0);
  for (const l of links) { outSum[l.source] += l.value; inSum[l.target] += l.value; }
  const value = nodes.map((_, i) => Math.max(inSum[i], outSum[i]) || 0);
  const maxCol = Math.max(0, ...nodes.map(n => n.col));

  const cols: number[][] = Array.from({ length: maxCol + 1 }, () => []);
  nodes.forEach((n, i) => cols[n.col].push(i));

  // A single value→pixel scale shared by every column (each column totals ≈ income),
  // chosen so the most crowded column still fits within H after padding.
  let scale = Infinity;
  for (const col of cols) {
    const tot = col.reduce((s, i) => s + value[i], 0);
    const avail = H - (col.length - 1) * NODE_PAD;
    if (tot > 0) scale = Math.min(scale, avail / tot);
  }
  if (!isFinite(scale) || scale <= 0) scale = 1;

  const colX = (c: number) => (maxCol === 0 ? MARGIN_X : MARGIN_X + (c * (W - 2 * MARGIN_X - NODE_W)) / maxCol);
  const pn: PlacedNode[] = nodes.map((n, i) => ({ ...n, idx: i, value: value[i], x: colX(n.col), y: 0, h: Math.max(1, value[i] * scale), order: 0 }));
  // Order every column by flow size (largest at the top); pin Savings to the
  // very bottom so it always sits below the spending groups.
  cols.forEach(col => col.forEach(i => {
    pn[i].order = pn[i].kind === 'savings' ? Number.POSITIVE_INFINITY : -value[i];
  }));

  // Stack each column vertically, centred, ordered by the `order` key.
  const place = () => {
    for (const col of cols) {
      const ordered = col.slice().sort((a, b) => pn[a].order - pn[b].order);
      const tot = ordered.reduce((s, i) => s + pn[i].h, 0) + (ordered.length - 1) * NODE_PAD;
      let y = Math.max(MARGIN_Y, (H - tot) / 2);
      for (const i of ordered) { pn[i].y = y; y += pn[i].h + NODE_PAD; }
    }
  };
  place();

  // Compute ribbon endpoints. Stack links on each node sorted by the opposite
  // end's position so ribbons don't cross where they meet a node.
  const bySource = new Map<number, number[]>();
  const byTarget = new Map<number, number[]>();
  links.forEach((l, li) => {
    (bySource.get(l.source) ?? bySource.set(l.source, []).get(l.source)!).push(li);
    (byTarget.get(l.target) ?? byTarget.set(l.target, []).get(l.target)!).push(li);
  });
  const sy = new Array(links.length), ty = new Array(links.length), th = new Array(links.length);
  for (const [s, lis] of bySource) {
    lis.sort((a, b) => pn[links[a].target].y - pn[links[b].target].y);
    let off = pn[s].y;
    for (const li of lis) { const t = links[li].value * scale; sy[li] = off + t / 2; off += t; th[li] = t; }
  }
  for (const [tn, lis] of byTarget) {
    lis.sort((a, b) => pn[links[a].source].y - pn[links[b].source].y);
    let off = pn[tn].y;
    for (const li of lis) { const t = links[li].value * scale; ty[li] = off + t / 2; off += t; }
  }

  return { pn, sy, ty, th, maxCol };
}

export default function CashFlowSankey({ privacy, cats, groups, onRecategorize, onCreateCategory, version = 0 }: {
  privacy: boolean;
  cats?: string[];
  groups?: PickerGroup[];
  onRecategorize?: (merchant: string, category: string) => void;
  onCreateCategory?: (merchant: string, name: string) => void;
  version?: number; // bump to re-fetch after a categorization elsewhere
}) {
  const [range, setRange] = usePersistentState<string>('mon.cashflowRange', '12m');
  const { data, loading, error } = useApi<CashFlow>(`/api/budget/cashflow?range=${range}`, [version]);
  const money = (n: number) => (privacy ? '••••' : '$' + Math.round(n).toLocaleString());

  // Measure the container so the SVG can render at exact pixel width (crisp text).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => { for (const e of entries) setWidth(e.contentRect.width); });
    ro.observe(el);
    setWidth(el.clientWidth || 900);
    return () => ro.disconnect();
  }, []);

  const income = data?.income ?? 0;
  const hasGraph = !!data && !loading && data.links.length > 0;

  const rowsPerCol = data ? Math.max(0, ...Array.from({ length: 4 }, (_, c) => data.nodes.filter(n => n.col === c).length)) : 0;
  const height = Math.max(380, rowsPerCol * 21 + MARGIN_Y * 2);
  const W = Math.max(560, width);

  const placed = hasGraph ? layout(data!.nodes, data!.links, W, height) : null;

  // Drill-down: clicking a node/band selects a filter and loads its transactions.
  const [sel, setSel] = useState<{ filter: NodeFilter; nodeIdx: number; label: string } | null>(null);
  const [txns, setTxns] = useState<CashTxnResp | null>(null);
  const [txnLoading, setTxnLoading] = useState(false);
  useEffect(() => {
    if (!sel) { setTxns(null); return; }
    setTxnLoading(true);
    let cancelled = false;
    const url = `/api/budget/cashflow/transactions?range=${range}&type=${sel.filter.type}&value=${encodeURIComponent(filterValue(sel.filter))}`;
    fetch(url).then(r => r.json()).then(d => { if (!cancelled) { setTxns(d); setTxnLoading(false); } }).catch(() => { if (!cancelled) setTxnLoading(false); });
    return () => { cancelled = true; };
  }, [sel, range, version]);
  const activeIdx = sel?.nodeIdx ?? null;

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      {/* Header: title + timeframe */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Cash Flow</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            Where your money comes from and where it goes{data ? ` · ${data.label}` : ''}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {RANGES.map(r => (
            <button key={r.key} onClick={() => { setRange(r.key); setSel(null); }} style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              background: range === r.key ? 'var(--accent)' : 'var(--bg)',
              color: range === r.key ? '#fff' : 'var(--muted)',
              border: '1px solid var(--border)',
            }}>{r.label}</button>
          ))}
        </div>
      </div>

      {data && (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
          {[
            { label: 'Income', value: data.income, color: '#22b8cf' },
            { label: 'Spending', value: data.spending, color: 'var(--amber)' },
            { label: data.savings >= 0 ? 'Saved' : 'Overspent', value: Math.abs(data.savings), color: data.savings >= 0 ? 'var(--green)' : 'var(--red)' },
          ].map(s => (
            <div key={s.label}>
              <p style={{ color: 'var(--muted)', fontSize: 11 }}>{s.label}</p>
              <p style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{money(s.value)}</p>
            </div>
          ))}
          {data.income > 0 && (
            <div>
              <p style={{ color: 'var(--muted)', fontSize: 11 }}>Savings rate</p>
              <p style={{ fontSize: 20, fontWeight: 700, color: data.savings >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {Math.round((data.savings / data.income) * 100)}%
              </p>
            </div>
          )}
        </div>
      )}

      {loading && <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Building cash-flow diagram…</div>}
      {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>Failed to load: {error}</p>}
      {data && !loading && data.links.length === 0 && (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>No transactions in this period.</p>
      )}

      {hasGraph && (
        <p style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>
          Click any band or block to list its transactions below.
        </p>
      )}

      <div ref={wrapRef} style={{ width: '100%' }}>
        {placed && (
          <svg width={W} height={height} style={{ display: 'block', filter: privacy ? 'blur(7px)' : 'none' }}>
            {/* Ribbons (drawn first, under the nodes) */}
            {data!.links.map((l, li) => {
              const s = placed.pn[l.source], t = placed.pn[l.target];
              const x0 = s.x + NODE_W, x1 = t.x, y0 = placed.sy[li], y1 = placed.ty[li];
              const mx = (x0 + x1) / 2;
              // Colour income inflows by the source (teal); everything downstream by
              // the spending / savings group it belongs to.
              const color = s.kind === 'hub' ? t.color : s.color;
              const touches = activeIdx != null && (l.source === activeIdx || l.target === activeIdx);
              const op = activeIdx == null ? 0.4 : touches ? 0.62 : 0.07;
              // Clicking a band drills into its destination — or its source for the
              // income inflows that all terminate at the central Income hub.
              const eff = t.kind === 'hub' ? s : t;
              return (
                <path
                  key={li}
                  d={`M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`}
                  fill="none" stroke={color} strokeWidth={Math.max(1, placed.th[li])} strokeOpacity={op}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSel({ filter: eff.filter, nodeIdx: eff.idx, label: eff.name })}
                >
                  <title>{`${s.name} → ${t.name}: ${money(l.value)}`}</title>
                </path>
              );
            })}

            {/* Nodes + labels */}
            {placed.pn.map(n => {
              const isFirst = n.col === 0;
              const lx = isFirst ? n.x - 8 : n.x + NODE_W + 8;
              const anchor = isFirst ? 'end' : 'start';
              const pct = income > 0 ? (n.value / income) * 100 : 0;
              const bold = n.kind === 'hub' || n.kind === 'group' || n.kind === 'savings';
              const selectedNode = activeIdx === n.idx;
              const dim = activeIdx != null && !selectedNode;
              return (
                <g key={n.idx} style={{ cursor: 'pointer' }}
                  onClick={() => setSel({ filter: n.filter, nodeIdx: n.idx, label: n.name })}>
                  <rect x={n.x} y={n.y} width={NODE_W} height={Math.max(1, n.h)} fill={n.color}
                    fillOpacity={dim ? 0.45 : 0.95} rx={2}
                    stroke={selectedNode ? TEXT : 'none'} strokeWidth={selectedNode ? 1.5 : 0}>
                    <title>{`${n.name}: ${money(n.value)} · ${pct.toFixed(1)}%`}</title>
                  </rect>
                  {n.h >= 7 && (
                    <text x={lx} y={n.y + n.h / 2 - (n.h >= 18 ? 5 : 0)} textAnchor={anchor} dominantBaseline="middle"
                      fontSize={11} fontWeight={bold ? 600 : 400} fill={TEXT}>
                      {n.name}
                    </text>
                  )}
                  {n.h >= 18 && (
                    <text x={lx} y={n.y + n.h / 2 + 8} textAnchor={anchor} dominantBaseline="middle" fontSize={10} fill={MUTED}>
                      {privacy ? `${pct.toFixed(1)}%` : `${money(n.value)} · ${pct.toFixed(1)}%`}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Drill-down transactions for the clicked node / band */}
      {sel && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>
              {sel.label}
              {txns && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {txns.txns.length} transaction{txns.txns.length === 1 ? '' : 's'} · {money(txns.total)}</span>}
            </h3>
            <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setSel(null)}>✕ Clear</button>
          </div>
          {txnLoading && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>}
          {!txnLoading && txns && txns.txns.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              {sel.filter.type === 'savings' ? 'Savings is income minus spending — it has no transactions of its own.' : 'No transactions.'}
            </p>
          )}
          {!txnLoading && txns && txns.txns.length > 0 && (
            <div style={{ maxHeight: 440, overflowY: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr 140px 150px 90px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                <span>Date</span><span>Merchant</span><span>Account</span><span>Category</span><span style={{ textAlign: 'right' }}>Amount</span>
              </div>
              {txns.txns.map(t => (
                <div key={t.id} title="Click for details"
                  onClick={() => openTxnDetail({ payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account, date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo })}
                  style={{ display: 'grid', gridTemplateColumns: '58px 1fr 140px 150px 90px', gap: 8, alignItems: 'center', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t.date.slice(5)}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                  </span>
                  <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</span>
                  {onRecategorize && cats ? (
                    <span onClick={e => e.stopPropagation()}>
                      <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact
                        onChange={c => onRecategorize(t.merchant, c)}
                        onCreate={onCreateCategory ? n => onCreateCategory(t.merchant, n) : undefined} />
                    </span>
                  ) : (
                    <span style={{ color: 'var(--muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.category}</span>
                  )}
                  <span style={{ textAlign: 'right', color: t.amount > 0 ? 'var(--green)' : 'var(--text)' }}>{money(t.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
