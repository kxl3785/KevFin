import { useEffect, useMemo, useRef, useState } from 'react';
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
const NODE_W = 13, NODE_PAD = 10, MARGIN_X = 178, MARGIN_Y = 14;

interface PlacedNode extends SankeyNode { idx: number; value: number; x: number; y: number; h: number; order: number }

// Lay the graph out left→right using the backend-provided `col` for each node, so
// income sources sit on the left, the Income hub in the middle, and spending /
// savings flow out to the right. Unlike recharts' Sankey we honour `col` exactly
// (recharts right-aligns any sink, which dumped Savings into the leaf column and
// made links swoop across the whole chart). A few barycenter passes order nodes
// within each column to minimise ribbon crossings, à la d3-sankey.
function layout(nodes: SankeyNode[], links: SankeyLink[], W: number, H: number, expandedGroup?: string | null) {
  const N = nodes.length;
  const inSum = new Array(N).fill(0), outSum = new Array(N).fill(0);
  for (const l of links) { outSum[l.source] += l.value; inSum[l.target] += l.value; }
  const value = nodes.map((_, i) => Math.max(inSum[i], outSum[i]) || 0);
  const maxCol = Math.max(0, ...nodes.map(n => n.col));

  const cols: number[][] = Array.from({ length: maxCol + 1 }, () => []);
  nodes.forEach((n, i) => cols[n.col].push(i));

  // A single value→pixel scale shared by every column (each column totals ≈ income),
  // chosen so the most crowded column still fits within H after padding AND the top
  // and bottom margins — otherwise a full column overflows and the last node (and its
  // label) gets clipped at the bottom.
  let scale = Infinity;
  for (const col of cols) {
    const tot = col.reduce((s, i) => s + value[i], 0);
    const avail = H - (col.length - 1) * NODE_PAD - 2 * MARGIN_Y;
    if (tot > 0) scale = Math.min(scale, avail / tot);
  }
  if (!isFinite(scale) || scale <= 0) scale = 1;

  const colX = (c: number) => (maxCol === 0 ? MARGIN_X : MARGIN_X + (c * (W - 2 * MARGIN_X - NODE_W)) / maxCol);
  const pn: PlacedNode[] = nodes.map((n, i) => ({ ...n, idx: i, value: value[i], x: colX(n.col), y: 0, h: Math.max(1, value[i] * scale), order: 0 }));
  // Cluster categories under their group for readability: rank groups (col 2) by
  // flow size, then order each category by its parent group's rank (so it sits
  // directly across from its group), largest-first within the group. Income sources
  // and the hub stay flow-ordered; Savings pins to the very bottom.
  const groupRank = new Map<number, number>();
  (cols[2] ?? []).filter(i => pn[i].kind === 'group').sort((a, b) => value[b] - value[a]).forEach((i, r) => groupRank.set(i, r));
  const parentGroup = new Map<number, number>();
  for (const l of links) if (pn[l.source]?.kind === 'group' && pn[l.target]?.kind === 'category') parentGroup.set(l.target, l.source);
  cols.forEach(col => col.forEach(i => {
    const n = pn[i];
    if (n.kind === 'savings') { n.order = Number.POSITIVE_INFINITY; return; }
    if (n.col === 3) {
      const g = parentGroup.get(i);
      n.order = (g != null ? (groupRank.get(g) ?? 999) : 999) * 1e9 - value[i];
    } else if (n.col === 2 && n.kind === 'group') {
      n.order = (groupRank.get(i) ?? 999) * 1e9;
    } else {
      n.order = -value[i];
    }
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

  // When a single group is fanned out, align its category column (col 3) with the
  // group's own bar instead of centring it — the categories sum to exactly the
  // group's height, so this yields a clean horizontal fan and a compact region the
  // caller can zoom into tightly. (Adjusted before ribbon endpoints, so they follow.)
  if (expandedGroup) {
    const gi = pn.findIndex(n => n.kind === 'group' && n.name === expandedGroup);
    if (gi >= 0 && cols[3]?.length) {
      let y = pn[gi].y;
      const ordered = cols[3].slice().sort((a, b) => pn[a].order - pn[b].order);
      for (const i of ordered) { pn[i].y = y; y += pn[i].h + NODE_PAD; }
    }
  }

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

// Stable identity for a node across re-derivations (names are unique within a graph).
const nodeKey = (n: SankeyNode) => `${n.kind}:${n.name}`;

// Build the rendered graph from the full (detailed) backend payload. The base view
// is always sources → Income → groups (+Savings). When a group is "expanded", that
// one group additionally fans out into its category leaf column; every other group
// stays collapsed. Returns the filtered nodes/links with link indices remapped, plus
// a category-node → parent-group lookup (used to frame a group's fan-out when zooming).
function deriveView(data: CashFlow, expanded: string | null): { nodes: SankeyNode[]; links: SankeyLink[]; parentOf: Map<number, string> } {
  const catParent = new Map<number, string>();
  for (const l of data.links) {
    const s = data.nodes[l.source], t = data.nodes[l.target];
    if (s?.kind === 'group' && t?.kind === 'category') catParent.set(l.target, s.name);
  }
  const keep: number[] = [];
  data.nodes.forEach((n, i) => {
    if (n.col !== 3) keep.push(i);                                   // sources, hub, groups, savings
    else if (expanded && catParent.get(i) === expanded) keep.push(i); // only the expanded group's categories
  });
  const remap = new Map<number, number>();
  keep.forEach((orig, idx) => remap.set(orig, idx));
  const nodes = keep.map(orig => data.nodes[orig]);
  const links = data.links
    .filter(l => remap.has(l.source) && remap.has(l.target))
    .map(l => ({ source: remap.get(l.source)!, target: remap.get(l.target)!, value: l.value }));
  const parentOf = new Map<number, string>();
  catParent.forEach((g, orig) => { if (remap.has(orig)) parentOf.set(remap.get(orig)!, g); });
  return { nodes, links, parentOf };
}

export default function CashFlowSankey({ privacy, cats, groups, onRecategorize, onCreateCategory, version = 0 }: {
  privacy: boolean;
  cats?: string[];
  groups?: PickerGroup[];
  onRecategorize?: (merchant: string, category: string, ctx?: { payee: string; description: string; amount: number }) => void;
  onCreateCategory?: (merchant: string, name: string) => void;
  version?: number; // bump to re-fetch after a categorization elsewhere
}) {
  const [range, setRange] = usePersistentState<string>('mon.cashflowRange', '12m');
  // Always fetch the full category detail; the diagram starts collapsed to groups
  // and progressively fans out one group's categories on click (see `expanded`).
  const { data, loading, error } = useApi<CashFlow>(`/api/budget/cashflow?range=${range}&detail=1`, [version]);
  const money = (n: number) => (privacy ? '••••' : '$' + Math.round(n).toLocaleString());

  // Which group is currently fanned out into its categories (null = all collapsed).
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => { setExpanded(null); }, [range]); // reset the drill-down when the period changes

  // Measure the container so the SVG can render at exact pixel width (crisp text).
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
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

  // Height is sized for the densest column we'd ever render at once: income sources,
  // the group tier, or a single expanded group's categories (we only fan out one
  // group at a time). Using the per-group max — not the total category count — keeps
  // the canvas a sane height and constant whether a group is expanded or not.
  const rows = useMemo(() => {
    if (!data) return 0;
    const sources = data.nodes.filter(n => n.col === 0).length;
    const groupTier = data.nodes.filter(n => n.col === 2).length;
    const perGroup = new Map<string, number>();
    for (const l of data.links) {
      const s = data.nodes[l.source], t = data.nodes[l.target];
      if (s?.kind === 'group' && t?.kind === 'category') perGroup.set(s.name, (perGroup.get(s.name) ?? 0) + 1);
    }
    return Math.max(sources, groupTier, 0, ...perGroup.values());
  }, [data]);
  const height = Math.max(440, rows * 34 + MARGIN_Y * 2);
  const W = Math.max(560, width);

  // The rendered graph: groups only, or one group fanned out into its categories.
  const view = useMemo(() => (hasGraph ? deriveView(data!, expanded) : null), [data, hasGraph, expanded]);
  const placed = view ? layout(view.nodes, view.links, W, height, expanded) : null;

  // Drill-down: clicking a node/band selects a filter and loads its transactions.
  // Keyed by a stable node identity so the selection survives the expand/collapse
  // re-derivation (where array indices change).
  const [sel, setSel] = useState<{ filter: NodeFilter; key: string; label: string } | null>(null);
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
  const activeKey = sel?.key ?? null;
  const activeIdx = useMemo(() => (view && activeKey != null ? view.nodes.findIndex(n => nodeKey(n) === activeKey) : -1), [view, activeKey]);

  // Clicking a group fans it out into its categories (and toggles closed if it was
  // already open); clicking a source/Income/Savings collapses the fan-out; clicking
  // a category just re-targets the zoom. Every click also loads the transactions.
  const pick = (n: SankeyNode) => {
    if (n.kind === 'group') {
      if (expanded === n.name) { setExpanded(null); setSel(null); return; }
      setExpanded(n.name);
    } else if (n.kind !== 'category') {
      setExpanded(null);
    }
    setSel({ filter: n.filter, key: nodeKey(n), label: n.name });
  };

  // Semantic zoom: when a node is selected, scale the diagram so it (and its
  // fan-out / neighbours) fills the frame. The geometry scales via `k`; label
  // visibility is judged on the *on-screen* height (`n.h * k`) so previously
  // unlabelled slivers gain labels as you zoom, and fonts are counter-scaled
  // (1/k) so text stays a constant, readable size rather than ballooning.
  const LABEL_PAD = 230; // room for node labels (name + amount + %) beside the bars
  const focus = useMemo(() => {
    if (!placed || !view || activeIdx < 0) return null;
    const active = view.nodes[activeIdx];
    const idxs = new Set<number>([activeIdx]);
    if (active.kind === 'group' && expanded === active.name) {
      for (const l of view.links) if (l.source === activeIdx) idxs.add(l.target); // group + its categories
    } else {
      for (const l of view.links) { if (l.source === activeIdx) idxs.add(l.target); if (l.target === activeIdx) idxs.add(l.source); }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hasLeft = false;
    for (const i of idxs) {
      const n = placed.pn[i];
      x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x + NODE_W);
      y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y + n.h);
      if (n.col === 0) hasLeft = true;
    }
    // Pad for labels (left column labels sit to the left; all others to the right).
    x0 -= hasLeft ? LABEL_PAD : 8;
    x1 += LABEL_PAD;
    y0 -= 16; y1 += 16;
    const rw = x1 - x0, rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return null;
    const k = Math.max(1, Math.min(W / rw, height / rh, 3.4));
    if (k <= 1.02) return null; // already fills the frame — skip a no-op transform
    const tx = (W - rw * k) / 2 - x0 * k;
    const ty = (height - rh * k) / 2 - y0 * k;
    return { k, tx, ty };
  }, [placed, view, activeIdx, expanded, W, height]);

  // Geometry zoom factor and its inverse (for counter-scaling fonts/offsets so they
  // keep a constant on-screen size while the bars and ribbons scale up).
  const k = focus?.k ?? 1, inv = 1 / k;

  // Export the diagram (exactly as shown — including any zoomed-in group) to a PNG.
  // `anonymize` strips the dollar figures so only the percentages remain, for sharing.
  const [exporting, setExporting] = useState(false);
  const exportPng = (anonymize: boolean) => {
    const svg = svgRef.current;
    if (!svg) return;
    setExporting(true);
    const SVGNS = 'http://www.w3.org/2000/svg';
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', SVGNS);
    clone.style.filter = 'none'; // never export the privacy blur
    clone.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    // Opaque background so the PNG isn't transparent.
    const bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', String(W)); bg.setAttribute('height', String(height)); bg.setAttribute('fill', '#15171e');
    clone.insertBefore(bg, clone.firstChild);
    let markup = new XMLSerializer().serializeToString(clone);
    if (anonymize) markup = markup
      .replace(/(?:\$[\d,]+(?:\.\d+)?|•+)\s*·\s*/g, '') // "$1,234 · 5.6%" → "5.6%" (visible labels)
      .replace(/\$[\d,]+(?:\.\d+)?/g, '');              // strip any bare "$1,234" left in tooltips
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const scale = 2; // crisp on retina
      const canvas = document.createElement('canvas');
      canvas.width = W * scale; canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.scale(scale, scale); ctx.drawImage(img, 0, 0); }
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        if (b) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = `cash-flow-${range}${anonymize ? '-anonymized' : ''}.png`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
        setExporting(false);
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); setExporting(false); };
    img.src = url;
  };

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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {RANGES.map(r => (
              <button key={r.key} onClick={() => { setRange(r.key); setSel(null); setExpanded(null); }} style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                background: range === r.key ? 'var(--accent)' : 'var(--bg)',
                color: range === r.key ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}>{r.label}</button>
            ))}
          </div>
          {hasGraph && (
            <div style={{ display: 'flex', gap: 4 }}>
              <button disabled={exporting} onClick={() => exportPng(false)} title="Download the diagram as a PNG image" style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: exporting ? 'default' : 'pointer',
                background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--border)', opacity: exporting ? 0.5 : 1,
              }}>⬇ Export PNG</button>
              <button disabled={exporting} onClick={() => exportPng(true)} title="Download as PNG with dollar amounts hidden (percentages only)" style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: exporting ? 'default' : 'pointer',
                background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--border)', opacity: exporting ? 0.5 : 1,
              }}>⬇ Export (% only)</button>
            </div>
          )}
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
          {expanded
            ? `Showing ${expanded}'s categories — click the group again to zoom back out, or any band to list its transactions.`
            : 'Click a spending group to zoom in and break it down; click any band or block to list its transactions below.'}
        </p>
      )}

      {/* The diagram needs ~178px of label margin on each side, so its minimum
          width (W = max(560, …)) exceeds a phone screen. Scroll it horizontally
          within the card rather than letting it overflow the page; on desktop the
          card is wider than 560 so there's nothing to scroll. */}
      <div ref={wrapRef} className="scroll-x" style={{ width: '100%' }}>
        {placed && (
          <svg ref={svgRef} width={W} height={height} style={{ display: 'block', filter: privacy ? 'blur(7px)' : 'none' }}>
            <g style={{
              transform: focus ? `translate(${focus.tx}px, ${focus.ty}px) scale(${focus.k})` : 'none',
              transformOrigin: '0 0',
              transition: 'transform 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
            }}>
            {/* Ribbons (drawn first, under the nodes) */}
            {view!.links.map((l, li) => {
              const s = placed.pn[l.source], t = placed.pn[l.target];
              const x0 = s.x + NODE_W, x1 = t.x, y0 = placed.sy[li], y1 = placed.ty[li];
              const mx = (x0 + x1) / 2;
              // Colour income inflows by the source (teal); everything downstream by
              // the spending / savings group it belongs to.
              const color = s.kind === 'hub' ? t.color : s.color;
              const touches = activeIdx >= 0 && (l.source === activeIdx || l.target === activeIdx);
              const op = activeIdx < 0 ? 0.4 : touches ? 0.62 : 0.07;
              // Clicking a band drills into its destination — or its source for the
              // income inflows that all terminate at the central Income hub.
              const eff = t.kind === 'hub' ? s : t;
              return (
                <path
                  key={li}
                  d={`M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`}
                  fill="none" stroke={color} strokeWidth={Math.max(1, placed.th[li])} strokeOpacity={op}
                  style={{ cursor: 'pointer' }}
                  onClick={() => pick(eff)}
                >
                  <title>{`${s.name} → ${t.name}: ${money(l.value)}`}</title>
                </path>
              );
            })}

            {/* Nodes + labels. Label visibility keys off on-screen height (h·k) so
                slivers gain labels when zoomed; fonts/offsets are counter-scaled (·inv). */}
            {placed.pn.map(n => {
              const isFirst = n.col === 0;
              const lx = isFirst ? n.x - 8 * inv : n.x + NODE_W + 8 * inv;
              const anchor = isFirst ? 'end' : 'start';
              const pct = income > 0 ? (n.value / income) * 100 : 0;
              const bold = n.kind === 'hub' || n.kind === 'group' || n.kind === 'savings';
              const selectedNode = activeIdx === n.idx;
              const dim = activeIdx >= 0 && !selectedNode;
              const hk = n.h * k; // on-screen bar height
              return (
                <g key={nodeKey(n)} style={{ cursor: 'pointer' }} onClick={() => pick(n)}>
                  <rect x={n.x} y={n.y} width={NODE_W} height={Math.max(1, n.h)} fill={n.color}
                    fillOpacity={dim ? 0.45 : 0.95} rx={2 * inv}
                    stroke={selectedNode ? TEXT : 'none'} strokeWidth={selectedNode ? 1.5 * inv : 0}>
                    <title>{`${n.name}: ${money(n.value)} · ${pct.toFixed(1)}%`}</title>
                  </rect>
                  {/* Categories (only shown when their group is expanded) always get a
                      one-line label with the amount + % appended, even hairline slivers.
                      Other nodes need a tall-enough bar and stack the amount below. */}
                  {n.kind === 'category' ? (
                    <text x={lx} y={n.y + n.h / 2} textAnchor={anchor} dominantBaseline="middle" fontSize={13 * inv} fill={TEXT}>
                      {n.name}
                      <tspan fill={MUTED} fontSize={11 * inv}>{privacy ? `  ${pct.toFixed(1)}%` : `  ${money(n.value)} · ${pct.toFixed(1)}%`}</tspan>
                    </text>
                  ) : hk >= 7 && (
                    <>
                      <text x={lx} y={n.y + n.h / 2 - (hk >= 24 ? 7 * inv : 0)} textAnchor={anchor} dominantBaseline="middle"
                        fontSize={13 * inv} fontWeight={bold ? 600 : 400} fill={TEXT}>
                        {n.name}
                      </text>
                      {hk >= 24 && (
                        <text x={lx} y={n.y + n.h / 2 + 9 * inv} textAnchor={anchor} dominantBaseline="middle" fontSize={11 * inv} fill={MUTED}>
                          {privacy ? `${pct.toFixed(1)}%` : `${money(n.value)} · ${pct.toFixed(1)}%`}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
            </g>
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
            <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => { setSel(null); setExpanded(null); }}>✕ Clear</button>
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
                  onClick={() => openTxnDetail({ payee: t.payee, merchant: t.merchant, amount: t.amount, category: t.category, account: t.account, date: t.date, postedAt: t.postedAt, transactedAt: t.transactedAt, description: t.description, memo: t.memo, suggested: t.suggested })}
                  style={{ display: 'grid', gridTemplateColumns: '58px 1fr 140px 150px 90px', gap: 8, alignItems: 'center', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{t.date.slice(5)}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <MerchantIcon merchant={t.merchant} label={t.payee} size={22} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payee}</span>
                      {t.description && t.description.toLowerCase() !== t.payee.toLowerCase() && (
                        <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }} title={t.description}>{t.description}</span>
                      )}
                    </span>
                  </span>
                  <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.account}>{t.account}</span>
                  {onRecategorize && cats ? (
                    <span onClick={e => e.stopPropagation()}>
                      <CategoryPicker value={t.category} options={cats} groups={groups} suggested={t.suggested} compact
                        onChange={c => onRecategorize(t.merchant, c, { payee: t.payee, description: t.description, amount: t.amount })}
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
