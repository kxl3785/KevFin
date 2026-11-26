import { useId, useMemo, useRef, useState } from 'react';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { fmtMoneyCompact } from '../../lib/format.ts';
import { fmtRatio } from '../../lib/feeDrag.ts';
import type { MixPart } from '../../lib/holdingProfile.ts';
import {
  splitPositions, unrealizedGain, sortPositions, defaultSortDir, type PositionSort, type PositionSortKey,
} from '../../lib/investments.ts';
import HoldingProfileEditor from './HoldingProfileEditor.tsx';
import { RatioEditor, fineMoney, sourceLabel, type FeeCheckupData, type FeeRow } from './FeeCheckup.tsx';
import { CARD, CardHeader, FOOTER, NOTE } from './ui.tsx';

// Positions on the Investments page: every holding, investments first with
// their share of invested money, then homes and manually tracked assets in
// their own "Other assets" group (they have no "% invested"). Each row's cost
// basis, asset class and yearly fund fee can be edited in place; a row with
// accounts opens to show them (and, where KevFin can't see inside a holding,
// to describe what it tracks). Columns sort on click. Open by default.

type Money = (n: number) => string;
interface AccountHolding { name: string; value: number; costBasis?: number | null }
type CostBasisSource = 'manual' | 'imported' | 'reported' | 'estimated';
type LookThrough = 'full' | 'top' | 'split' | 'name';
export interface HoldingRow {
  symbol: string; name: string; value: number; costBasis: number | null; costBasisCoveredValue: number; costBasisComplete: boolean;
  costBasisSource: CostBasisSource | null; pct: number; assetClass: string; overridden: boolean; accounts: AccountHolding[];
  profileId?: string; profile?: MixPart[] | null; lookThrough?: LookThrough;
}

// Stable id for a holding's override, matching the server's holdingId().
export const idOf = (symbol: string, name: string) => (symbol && symbol.trim() ? symbol.trim() : name.trim());

// Investments shown before "Show N more".
const POS_LIMIT = 10;
const COLS = 9;

// What KevFin could see inside a holding (server: LookThroughQuality).
const LOOK_THROUGH: Record<LookThrough, string> = {
  full: 'KevFin can see what’s inside this one.',
  top: 'Only its top holdings are published; the rest counts as diversified.',
  split: 'Only its stock / bond / cash split is known, not its holdings.',
  name: 'No holdings data: classified from its name.',
};

const signed = (n: number, money: Money) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
const signedPct = (p: number) => `${p >= 0 ? '+' : '−'}${(Math.abs(p) * 100).toFixed(1)}%`;

interface FeeState { data: FeeCheckupData | null; loading: boolean; error: string | null; refetch: () => unknown }

function PositionRow({ h, invested, investedTotal, money, moneyFine, editable, fee, feeState, onClassify, onEditBasis, onProfileSaved, onFeeSaved }: {
  h: HoldingRow; invested: boolean; investedTotal: number; money: Money; moneyFine: Money; editable: boolean;
  fee: FeeRow | undefined; feeState: FeeState;
  onClassify: (id: string) => void; onEditBasis: (id: string) => void; onProfileSaved: () => void; onFeeSaved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingFee, setEditingFee] = useState(false);
  // Focus goes back to the fee cell when its editor closes (save, Escape, Cancel).
  const feeBtn = useRef<HTMLButtonElement>(null);
  const closeFee = () => { setEditingFee(false); requestAnimationFrame(() => feeBtn.current?.focus()); };
  const id = idOf(h.symbol, h.name);
  const cb = h.costBasis;
  // Measure gain against only the value that has a known basis, so a PARTIAL
  // basis isn't charged against the whole position (which would overstate gain).
  const gain = cb != null ? h.costBasisCoveredValue - cb : null;
  const gainPct = gain != null && cb ? gain / cb : null;
  const gainColor = gain == null ? 'var(--muted)' : gain >= 0 ? 'var(--green)' : 'var(--red)';
  const partial = cb != null && !h.costBasisComplete;
  const expandable = h.accounts.length > 0;
  // Offer "describe what this tracks" where the data is thin: no ticker, or
  // only a split / a name to go on — or once the user has described it.
  const describable = expandable && (!!h.profile?.length || !h.symbol || h.lookThrough === 'split' || h.lookThrough === 'name');
  const limited = !h.profile?.length && (h.lookThrough === 'split' || h.lookThrough === 'name');

  const estimated = h.costBasisSource === 'estimated';
  const costTitle = cb == null
    ? (editable ? 'Click to add a cost basis' : 'No cost basis available for this position')
    : partial ? 'Partial basis — known for only some lots; gain is shown on the covered portion. Click to override.'
    : h.costBasisSource === 'manual' ? 'Manually entered — click to edit or clear'
    : h.costBasisSource === 'imported' ? 'Imported from a document (1099-B / statement) — click to override'
    : estimated ? 'Estimated: shares × price on the acquisition date — a rough guess. Click to set the real value.'
    : 'Reported by your institution — click to override';

  // Fee cells: only investments have a fund fee; other assets read n/a.
  let feeCell: React.ReactNode, feeCostCell: React.ReactNode;
  if (!invested) {
    feeCell = <small style={{ color: 'var(--muted)' }}>n/a</small>;
    feeCostCell = <small style={{ color: 'var(--muted)' }}>n/a</small>;
  } else if (!fee) {
    const t = feeState.loading ? '…' : '—';
    feeCell = <span style={{ color: 'var(--muted)' }} title={feeState.loading ? 'Looking up fund fees' : 'No fee figure'}>{t}</span>;
    feeCostCell = <span style={{ color: 'var(--muted)' }}>{t}</span>;
  } else {
    const none = fee.source === 'stock' || fee.source === 'cash' || fee.source === 'not-fund';
    feeCell = fee.expenseRatio == null ? (
      <button ref={feeBtn} type="button" className="inv-cell-btn" onClick={() => setEditingFee(e => !e)} aria-expanded={editingFee}
        style={{ color: 'var(--accent)', fontSize: 12 }} aria-label={`Add the yearly fee for ${h.symbol || h.name}`}>+ add</button>
    ) : (
      <button ref={feeBtn} type="button" className="inv-cell-btn edit" onClick={() => setEditingFee(e => !e)} aria-expanded={editingFee}
        title={`${sourceLabel(fee)} · click to enter your own figure`}
        aria-label={`${none ? 'No fund fee' : `${fmtRatio(fee.expenseRatio)} a year`}, ${sourceLabel(fee)}. Edit the yearly fee for ${h.symbol || h.name}`}
        style={{ color: none ? 'var(--muted)' : 'var(--text)' }}>
        {none ? <small>none</small> : fmtRatio(fee.expenseRatio)}
        {fee.source === 'manual' && <span style={{ color: 'var(--accent)' }} title="Your figure"> •</span>}
      </button>
    );
    feeCostCell = fee.annualCost == null ? <span style={{ color: 'var(--muted)' }}>—</span>
      : <span style={{ color: fee.annualCost === 0 ? 'var(--muted)' : 'var(--text)' }}>{moneyFine(fee.annualCost)}</span>;
  }

  return (
    <>
      <tr>
        <td className="l" style={{ width: 18, paddingRight: 0 }}>
          {expandable && (
            <button type="button" className="inv-cell-btn" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} accounts holding ${h.symbol || h.name}`}
              style={{ color: 'var(--muted)', fontSize: 10, width: 16 }}>{expanded ? '▾' : '▸'}</button>
          )}
        </td>
        <td className="l">
          <span className="inv-pos-holding">
            {h.symbol && <span className="tk">{h.symbol}</span>}
            <span className="nm" title={h.name} style={!h.symbol ? { color: 'var(--text)' } : undefined}>
              {h.profile?.length ? <span title="You described what this tracks" style={{ color: 'var(--accent)', marginRight: 5 }}>◆</span>
                : limited && expandable ? <span title={`${LOOK_THROUGH[h.lookThrough!]} Open the row to describe what it tracks.`} style={{ color: 'var(--amber)', marginRight: 5 }}>◇</span> : null}
              {h.name}
            </span>
          </span>
        </td>
        <td className="l">
          <button type="button" className="inv-cell-btn edit" onClick={() => onClassify(id)}
            title={h.overridden ? 'Manually set — click to change asset class' : 'Click to change asset class'}
            style={{ fontSize: 12, color: h.overridden ? 'var(--accent)' : 'var(--muted)' }}>
            {h.assetClass}{h.overridden ? ' •' : ''} <span aria-hidden="true" style={{ opacity: 0.5 }}>✎</span>
          </button>
        </td>
        <td>{money(h.value)}</td>
        <td style={{ color: 'var(--muted)' }}>{invested && investedTotal > 0 ? `${(h.value / investedTotal * 100).toFixed(1)}%` : <small>n/a</small>}</td>
        <td>
          {editable ? (
            <button type="button" className="inv-cell-btn" onClick={() => onEditBasis(id)} title={costTitle}
              style={{ color: cb == null ? 'var(--accent)' : estimated ? 'var(--muted)' : 'var(--text)', fontSize: cb == null ? 12 : 13 }}>
              {cb != null ? (
                <>
                  {estimated ? '≈ ' : ''}{money(cb)}
                  {partial ? <span style={{ color: 'var(--amber)' }} title="partial"> ~</span>
                    : h.costBasisSource === 'manual' ? <span style={{ color: 'var(--accent)' }} title="manual"> •</span>
                    : h.costBasisSource === 'imported' ? <span style={{ color: 'var(--muted)', fontSize: 10 }} title="imported"> imp</span>
                    : null}
                </>
              ) : '+ add'}
            </button>
          ) : <span style={{ color: 'var(--muted)' }} title={costTitle}>{cb != null ? money(cb) : '—'}</span>}
        </td>
        <td style={{ color: gainColor }} title={partial ? 'Gain on the portion with a known basis only' : undefined}>
          {gain == null ? '—' : (
            <>
              {partial && (
                <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 8, padding: '0 5px', marginRight: 6, verticalAlign: 'middle' }}>partial</span>
              )}
              {signed(gain, money)}
              {gainPct != null && <small style={{ opacity: 0.8, marginLeft: 5 }}>{signedPct(gainPct)}{partial ? '*' : ''}</small>}
            </>
          )}
        </td>
        <td>{feeCell}</td>
        <td>{feeCostCell}</td>
      </tr>

      {editingFee && fee && (
        <tr className="detail">
          <td colSpan={COLS}>
            <RatioEditor row={fee} onDone={closeFee} onSaved={onFeeSaved} />
          </td>
        </tr>
      )}

      {expanded && expandable && (
        <tr className="detail">
          <td colSpan={COLS}>
            {(h.lookThrough || describable) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px', fontSize: 12, paddingBottom: 8 }}>
                {h.lookThrough && <span style={{ color: 'var(--muted)' }}>{h.profile?.length ? 'Breakdown follows your description.' : LOOK_THROUGH[h.lookThrough]}</span>}
                {describable && <HoldingProfileEditor id={h.profileId ?? id} name={h.name} mix={h.profile ?? null} onSaved={onProfileSaved} />}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px 110px 120px', maxWidth: 560, fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '2px 0 4px' }}>
              <span>Account</span><span style={{ textAlign: 'right' }}>Value</span><span style={{ textAlign: 'right' }}>Cost</span><span style={{ textAlign: 'right' }}>Gain / loss</span>
            </div>
            {h.accounts.map(a => {
              const acb = a.costBasis ?? null;
              const ag = acb != null ? a.value - acb : null;
              const agColor = ag == null ? 'var(--muted)' : ag >= 0 ? 'var(--green)' : 'var(--red)';
              return (
                <div key={a.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px 110px 120px', maxWidth: 560, fontSize: 12, padding: '3px 0' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>{a.name}</span>
                  <span style={{ textAlign: 'right' }}>{money(a.value)}</span>
                  <span style={{ textAlign: 'right', color: 'var(--muted)' }} title={acb == null ? 'No cost basis reported for this account' : undefined}>{acb != null ? money(acb) : '—'}</span>
                  <span style={{ textAlign: 'right', color: agColor, whiteSpace: 'nowrap' }}>{ag == null ? '—' : signed(ag, money)}</span>
                </div>
              );
            })}
          </td>
        </tr>
      )}
    </>
  );
}

export default function PositionsCard({
  holdings, realEstateNames, selectedClass, onClearClass, money, privacy, estimateBasis, onEstimateBasis,
  onClassify, onEditBasis, onProfileSaved, fees, reserveRight = 0,
}: {
  holdings: HoldingRow[];
  realEstateNames: Set<string>;
  selectedClass: string | null;
  onClearClass: () => void;
  money: Money;
  privacy: boolean;
  estimateBasis: boolean;
  onEstimateBasis: (on: boolean) => void;
  onClassify: (id: string) => void;
  onEditBasis: (id: string) => void;
  onProfileSaved: () => void;
  fees: FeeState;
  reserveRight?: number;
}) {
  const [open, setOpen] = usePersistentState('mon.positionsOpen', true);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<PositionSort>({ key: 'value', dir: 'desc' });
  const bodyId = useId();
  const moneyFine = fineMoney(privacy);
  const compactMoney = (n: number) => (privacy ? '••••••' : fmtMoneyCompact(n));

  const { invested, other } = useMemo(() => splitPositions(holdings), [holdings]);
  const investedTotal = invested.reduce((s, h) => s + h.value, 0);
  const g = unrealizedGain(invested);
  const feeById = useMemo(() => new Map((fees.data?.rows ?? []).map(r => [r.id, r])), [fees.data]);

  // Filters: the asset class picked on the allocation card, and the search box.
  const q = search.trim().toLowerCase();
  const match = (h: HoldingRow) => (!selectedClass || h.assetClass === selectedClass)
    && (!q || h.symbol.toLowerCase().includes(q) || h.name.toLowerCase().includes(q));
  const feeOf = (h: HoldingRow) => feeById.get(idOf(h.symbol, h.name));
  const inv = sortPositions(invested.filter(match), sort, feeOf);
  const oth = sortPositions(other.filter(match), sort, () => null);
  const filtering = !!q || !!selectedClass;
  const shownInv = showAll || filtering ? inv : inv.slice(0, POS_LIMIT);
  const hiddenCount = inv.length - shownInv.length;
  const anyPartial = holdings.some(h => h.costBasis != null && !h.costBasisComplete);

  const onSort = (key: PositionSortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultSortDir(key) }));
  const th = (key: PositionSortKey | null, label: React.ReactNode, left = false, title?: string, arrow = true) => {
    const active = key && sort.key === key;
    return (
      <th scope="col" className={left ? 'l' : undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        {key ? (
          <button type="button" onClick={() => onSort(key)} title={title ?? `Sort by ${typeof label === 'string' ? label.toLowerCase() : 'this column'}`}
            style={active ? { color: 'var(--text)' } : undefined}>
            {label}{active && arrow ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        ) : label}
      </th>
    );
  };
  const rowProps = (h: HoldingRow, isInv: boolean) => ({
    h, invested: isInv, investedTotal, money, moneyFine,
    editable: !!h.symbol || !realEstateNames.has(h.name),
    fee: isInv ? feeOf(h) : undefined, feeState: fees,
    onClassify, onEditBasis, onProfileSaved, onFeeSaved: () => fees.refetch(),
  });
  const unknownFees = fees.data?.unknownCount ?? 0;
  const unknownValue = fees.data ? Math.max(0, fees.data.totalValue - fees.data.coveredValue) : 0;

  return (
    <section aria-label="Positions" style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={reserveRight}
        title={<>Positions <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({holdings.length})</span></>}
        collapse={{ open, onToggle: () => setOpen(o => !o), controls: bodyId }}
        subtitle={g.gain != null ? (
          <>
            <span style={{ fontWeight: 600, color: privacy ? 'var(--text)' : g.gain >= 0 ? 'var(--green)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>
              {signed(g.gain, money)}
              {g.pct != null && <span style={{ opacity: 0.8, fontWeight: 400, marginLeft: 5 }}>{signedPct(g.pct)}</span>}
            </span>
            {' '}unrealized on investments · covers {g.withCost} of {g.count} ({compactMoney(g.coveredValue)} of {compactMoney(g.allValue)})
            {g.anyEstimated && estimateBasis ? ' · includes estimated basis' : ''}
            {' '}· click a column to sort
          </>
        ) : 'Click a column to sort'}
      />

      {open && (
        <div id={bodyId}>
          {selectedClass && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 2px' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 6px 4px 11px',
                borderRadius: 14, background: 'var(--accent-dim)', border: '1px solid var(--accent)', color: 'var(--text)',
              }}>
                {selectedClass} <span style={{ color: 'var(--muted)' }}>({inv.length + oth.length})</span>
                <button type="button" onClick={onClearClass} aria-label="Clear the asset-class filter" title="Clear filter"
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
              </span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0 12px', flexWrap: 'wrap' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search symbol or name…"
              aria-label="Search positions"
              style={{ flex: '1 1 180px', maxWidth: 280, padding: '6px 10px', fontSize: 13 }}
            />
            <label
              title="For positions with no basis, estimate one from shares × the price on the acquisition date. Rough — shown as ≈ and clearly flagged."
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <input type="checkbox" checked={estimateBasis} onChange={e => onEstimateBasis(e.target.checked)} />
              Estimate missing (≈)
            </label>
          </div>

          {/* Wider than a phone: it scrolls sideways inside the card. */}
          <div className="scroll-x"><div className="tbl-scroll" style={{ ['--tbl-min']: '820px' } as React.CSSProperties}>
            <table className="inv-pos">
              <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Your positions</caption>
              <thead>
                <tr>
                  <th scope="col" className="l" style={{ width: 18 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Accounts</span></th>
                  {th('name', 'Holding', true)}
                  {th('class', 'Class', true)}
                  {th('value', 'Value')}
                  {th('value', '% invested', false, 'Share of invested money — sorts by value', false)}
                  {th('cost', 'Cost')}
                  {th('gain', 'Gain / loss')}
                  {th('fee', 'Fee', false, "Sort by yearly fee — the fund's expense ratio, taken out of its value automatically")}
                  {th('feeCost', 'Cost / yr', false, 'Sort by what the fee costs a year at today’s balance')}
                </tr>
              </thead>
              <tbody>
                {shownInv.map(h => <PositionRow key={idOf(h.symbol, h.name)} {...rowProps(h, true)} />)}
                {hiddenCount > 0 && (
                  <tr>
                    <td colSpan={COLS} className="l">
                      <button type="button" className="inv-link" onClick={() => setShowAll(true)} style={{ minHeight: 28 }}>Show {hiddenCount} more</button>
                    </td>
                  </tr>
                )}
                {showAll && !filtering && inv.length > POS_LIMIT && (
                  <tr>
                    <td colSpan={COLS} className="l">
                      <button type="button" className="inv-link" onClick={() => setShowAll(false)} style={{ minHeight: 28 }}>Show fewer</button>
                    </td>
                  </tr>
                )}
                {inv.length === 0 && invested.length > 0 && (
                  <tr><td colSpan={COLS} className="l" style={{ color: 'var(--muted)' }}>No investments match.</td></tr>
                )}
                {oth.length > 0 && (
                  <>
                    <tr className="grp"><td colSpan={COLS}>Other assets · not counted in “% invested”</td></tr>
                    {oth.map(h => <PositionRow key={idOf(h.symbol, h.name)} {...rowProps(h, false)} />)}
                  </>
                )}
                {inv.length === 0 && oth.length === 0 && (
                  <tr>
                    <td colSpan={COLS} className="l" style={{ color: 'var(--muted)', padding: '12px 0' }}>
                      {selectedClass && q ? `No ${selectedClass} positions match “${search}”.`
                        : selectedClass ? `No positions classified as ${selectedClass}.` : `No positions match “${search}”.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div></div>

          {anyPartial && (
            <p style={{ ...NOTE, marginTop: 10 }}>
              * Partial basis: gain is calculated on the portion of the position with a known cost basis only.
            </p>
          )}
          {unknownFees > 0 && (
            <p style={{ ...NOTE, marginTop: 10, borderLeft: '3px solid var(--amber)', paddingLeft: 10 }}>
              <strong style={{ color: 'var(--text)' }}>Partial picture:</strong>{' '}
              {unknownFees} holding{unknownFees === 1 ? '' : 's'} ({money(unknownValue)}) {unknownFees === 1 ? 'has' : 'have'} no published fee, so {unknownFees === 1 ? 'it is' : 'they are'} left out of the fee figures.
              {' '}Use “+ add” in the Fee column to enter one from the fund's fact sheet.
            </p>
          )}
          {fees.error && !fees.data && (
            <p role="alert" style={{ ...NOTE, color: 'var(--red)', marginTop: 10 }}>
              Couldn't look up fund fees: {fees.error}.{' '}
              <button type="button" className="inv-link" onClick={() => fees.refetch()}>Retry</button>
            </p>
          )}
          <p style={FOOTER}>
            Fund fees come from published fund data (Yahoo Finance, or the fund's SEC shareholder report when Yahoo has none), looked up by ticker symbol only, and can lag a fund's latest change; your own figures always take precedence.
          </p>
        </div>
      )}
    </section>
  );
}
