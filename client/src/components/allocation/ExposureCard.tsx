import { useId, useRef, useState } from 'react';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import WorldMap from '../WorldMap.tsx';
import { SecLookThroughNotice } from '../SecContactEmail.tsx';
import { isGeographic } from '../../lib/countryExposure.ts';
import { isPseudoStock, isRealSector, topConcentration } from '../../lib/investments.ts';
import { CARD, CardHeader } from './ui.tsx';

// "What you own" on the Investments page: the three look-through lists of the
// earlier page (country / region, sector, stock) as tabs of one card. In each
// list the percent leads and dollars follow, every bar is the accent colour,
// and click a row to see what it's made of (hover a stock for the accounts
// holding it). Rows that aren't really members of the list — the bond / cash
// part of funds, "diversified" remainders, places not on the map — are a
// footnote, with "Show them" to list them too. All shares are of invested money
// (brokerage), excluding real estate and other assets.

type Money = (n: number) => string;
interface Contributor { label: string; value: number }
interface Slice { name: string; value: number; pct: number; contributors: Contributor[]; code?: string }
interface AccountHolding { name: string; value: number }
// note: how the row was derived, in plain words (what share of Berkshire was
// opened into the stocks in its 13F, and as of when). aliases: the company's
// other tickers the server folded into this row (GOOG under GOOGL, 2330 under
// TSM). Two rows may share a symbol — one exchange code, two companies (BN is
// Brookfield and Danone) — so the symbol alone isn't a key.
interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: AccountHolding[]; note?: string; aliases?: string[] }

interface Row { key: string; label: string; sublabel?: string; footLabel?: string; value: number; pct: number; detail: Contributor[]; detailHeading: string; detailUnit: string; accounts?: AccountHolding[]; note?: string; aliases?: string[] }

// "also GOOG", "also CIBEST and PFCIBEST": a merged row's other tickers.
const alsoText = (aliases: string[]) => `also ${aliases.length > 1 ? `${aliases.slice(0, -1).join(', ')} and ${aliases[aliases.length - 1]}` : aliases[0]}`;

type Tab = 'regions' | 'sectors' | 'stocks';
const TABS: [Tab, string][] = [['regions', 'Regions'], ['sectors', 'Sectors'], ['stocks', 'Stocks']];
const LIMIT = 8;

const pctText = (p: number) => `${(p * 100).toFixed(1)}%`;
// Plain names for the stock list's pseudo-rows, in the footnote and when shown.
const PSEUDO_STOCK: Record<string, string> = { '— non-equity —': 'Bonds, commodities and cash', '— diversified —': 'Beyond published holdings' };
const PSEUDO_FOOT: Record<string, string> = { '— non-equity —': 'bonds, commodities and cash', '— diversified —': 'the part beyond their published holdings' };

// One ranked list with drill-down. `extra` rows (the footnoted pseudo-rows) are
// appended, muted, when the user asks to see them.
function RankList({ rows, extra, money, label, showExtra }: { rows: Row[]; extra: Row[]; money: Money; label: string; showExtra: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const shown = showAll ? rows : rows.slice(0, LIMIT);
  const all = showExtra ? [...shown, ...extra] : shown;
  // Bars are scaled to the biggest row on screen, so a 79% "United States"
  // doesn't leave everything else as a sliver… but they still read as shares.
  const max = Math.max(0.0001, ...all.map(r => r.pct));
  const extraKeys = new Set(extra.map(r => r.key));
  return (
    <div>
      <div id={listId} role="list" aria-label={label}>
        {all.map(r => {
          const isOpen = open === r.key;
          const hasAccts = !!r.accounts?.length;
          return (
            <div key={r.key} role="listitem" style={{ position: 'relative' }}
              onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(h => (h === r.key ? null : h))}>
              <button type="button" className={'inv-rank-row' + (extraKeys.has(r.key) ? ' muted' : '')} aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : r.key)}
                title={[r.aliases?.length ? `${r.label}, ${alsoText(r.aliases)}` : null, r.note, hasAccts ? 'Hover for accounts · click for breakdown' : "Click to see what's counted here"].filter(Boolean).join('\n')}>
                <span className="inv-rank-label">
                  <span aria-hidden="true" style={{ display: 'inline-block', width: 12, color: 'var(--muted)', fontSize: 10 }}>{isOpen ? '▾' : '▸'}</span>
                  <strong style={{ fontWeight: 600 }}>{r.label}</strong>{r.sublabel && <small>{r.sublabel}</small>}
                  {r.aliases?.length ? <small>· {alsoText(r.aliases)}</small> : null}
                </span>
                <span className="inv-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (r.pct / max) * 100)}%` }} /></span>
                <span className="inv-rank-pct">{pctText(r.pct)}</span>
                <span className="inv-rank-amt">{money(r.value)}</span>
              </button>
              {hover === r.key && hasAccts && !isOpen && (
                <div style={{
                  position: 'absolute', left: 18, top: '100%', zIndex: 20,
                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                  padding: '8px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.3)', minWidth: 220, maxWidth: 'calc(100% - 18px)',
                }}>
                  <p style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Held in</p>
                  {r.accounts!.map(a => (
                    <div key={a.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0', gap: 16 }}>
                      <span>{a.name}</span>
                      <span style={{ color: 'var(--muted)' }}>{money(a.value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {isOpen && (
                <div style={{ margin: '4px 0 8px 18px', paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
                  {r.note && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>{r.note}</p>}
                  {r.aliases?.length ? <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 6px' }}>Also listed as {r.aliases.join(', ')} — counted here as one company.</p> : null}
                  <p style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{r.detailHeading}</p>
                  {r.detail.map(c => (
                    <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '3px 0', color: 'var(--muted)' }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                      <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{r.value ? (c.value / r.value * 100).toFixed(1) : '0.0'}%</strong> of this {r.detailUnit} · {money(c.value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {rows.length > LIMIT && (
        <button type="button" className="inv-link" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(s => !s)}
          style={{ marginTop: 6, minHeight: 28 }}>
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

// "Bonds / commodities / cash 7.2% and diversified 1.5% aren't stocks." The
// footnote naming the pseudo-rows, with a toggle that lists them.
function Footnote({ extra, lead, tail, show, onToggle }: { extra: Row[]; lead: string; tail: string; show: boolean; onToggle: () => void }) {
  if (!extra.length) return null;
  const total = extra.reduce((s, r) => s + r.pct, 0);
  return (
    <p className="inv-fine">
      {lead}{' '}
      {extra.map((r, i) => (
        <span key={r.key}>{i > 0 ? (i === extra.length - 1 ? ' and ' : ', ') : ''}{r.footLabel ?? r.label} {pctText(r.pct)}</span>
      ))}
      {extra.length > 1 ? ` (${pctText(total)} in all)` : ''}{/^[.,;]/.test(tail) ? tail : ` ${tail}`}{' '}
      <button type="button" className="inv-link" aria-expanded={show} onClick={onToggle}>{show ? 'Hide them' : 'Show them'}</button>
    </p>
  );
}

export default function ExposureCard({ byCountry, bySector, byStock, money, lookThrough, onLookThroughSaved, reserveRight = 0 }: {
  byCountry: Slice[];
  bySector: Slice[];
  byStock: StockExposure[];
  money: Money;
  lookThrough?: { issue: 'no-contact' | 'blocked'; detail: string };
  onLookThroughSaved: () => void;
  reserveRight?: number;
}) {
  const [tabPref, setTab] = usePersistentState<Tab>('mon.exposureTab', 'regions');
  const tab: Tab = TABS.some(([t]) => t === tabPref) ? tabPref : 'regions';
  // "Show them" is per tab: listing the sector footnote's rows says nothing
  // about the regions or stocks lists.
  const [showExtraBy, setShowExtraBy] = useState<Record<Tab, boolean>>({ regions: false, sectors: false, stocks: false });
  const showExtra = showExtraBy[tab];
  const toggleExtra = () => setShowExtraBy(m => ({ ...m, [tab]: !m[tab] }));
  const tabIds = useId();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ regions: null, sectors: null, stocks: null });

  const slice = (s: Slice, unit: string): Row => ({ key: s.name, label: s.name, value: s.value, pct: s.pct, detail: s.contributors, detailHeading: 'Counted from', detailUnit: unit });
  const regionRows = byCountry.filter(s => isGeographic(s.name)).map(s => slice(s, 'country'));
  const regionExtra = byCountry.filter(s => !isGeographic(s.name)).map(s => slice(s, 'bucket'));
  const sectorRows = bySector.filter(s => isRealSector(s.name)).map(s => slice(s, 'sector'));
  const sectorExtra = bySector.filter(s => !isRealSector(s.name) && s.pct > 0.0005).map(s => slice(s, 'bucket'));
  // Keys: symbol and name, with a count should even that pair repeat.
  const seenKeys = new Map<string, number>();
  const stockKey = (s: StockExposure) => {
    const base = `${s.symbol}|${s.name}`;
    const n = seenKeys.get(base) ?? 0;
    seenKeys.set(base, n + 1);
    return n ? `${base}|${n}` : base;
  };
  const stock = (s: StockExposure, pseudo: boolean): Row => ({
    key: stockKey(s), aliases: pseudo ? undefined : s.aliases, label: pseudo ? (PSEUDO_STOCK[s.symbol] ?? s.name) : s.symbol, footLabel: pseudo ? PSEUDO_FOOT[s.symbol] : undefined, sublabel: pseudo ? undefined : s.name, value: s.value, pct: s.pct,
    detail: s.sources, detailHeading: 'Exposure via', detailUnit: pseudo ? 'bucket' : 'stock', accounts: s.accounts, note: s.note,
  });
  const stockRows = byStock.filter(s => !isPseudoStock(s.symbol)).map(s => stock(s, false));
  const stockExtra = byStock.filter(s => isPseudoStock(s.symbol)).map(s => stock(s, true));
  const conc = topConcentration(byStock);

  // Arrow keys move between tabs (the WAI-ARIA tabs pattern).
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(([t]) => t === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
    setTab(next);
    tabRefs.current[next]?.focus();
    e.preventDefault();
  };

  const tabs = (
    <div className="inv-tabs" role="tablist" aria-label="What you own by" onKeyDown={onTabKey}>
      {TABS.map(([t, label]) => (
        <button key={t} ref={el => { tabRefs.current[t] = el; }} type="button" role="tab" id={`${tabIds}-${t}`}
          aria-selected={tab === t} aria-controls={`${tabIds}-panel`} tabIndex={tab === t ? 0 : -1}
          onClick={() => setTab(t)}>{label}</button>
      ))}
    </div>
  );

  return (
    <section aria-label="What you own" style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={reserveRight} title="What you own" controls={tabs}
        tip="Includes what's inside your funds, added up across every account. Shares are of invested money, excluding real estate and other assets. Click any row to see what it's made of."
        subtitle="Inside your funds too · share of invested money" />
      {lookThrough && <SecLookThroughNotice issue={lookThrough.issue} detail={lookThrough.detail} onSaved={onLookThroughSaved} />}

      <div id={`${tabIds}-panel`} role="tabpanel" aria-labelledby={`${tabIds}-${tab}`}>
        {tab === 'regions' && (
          <>
            <div style={{ marginBottom: 12 }}><WorldMap data={byCountry} money={money} /></div>
            <RankList rows={regionRows} extra={regionExtra} money={money} label="Exposure by country" showExtra={showExtra} />
            <Footnote extra={regionExtra} lead="Not on the map:" tail="." show={showExtra} onToggle={toggleExtra} />
          </>
        )}
        {tab === 'sectors' && (
          <>
            <RankList rows={sectorRows} extra={sectorExtra} money={money} label="Exposure by sector" showExtra={showExtra} />
            <Footnote extra={sectorExtra} lead="Not company shares, so not a sector:" tail="." show={showExtra} onToggle={toggleExtra} />
          </>
        )}
        {tab === 'stocks' && (
          <>
            {conc && (
              <p className="inv-callout" style={{ marginBottom: 10 }}>
                Your top {conc.symbols.length} stocks ({conc.symbols.join(', ')}) are <strong>{pctText(conc.pct)}</strong> of everything invested
                {conc.viaFunds >= 0.5 ? ', mostly through your funds.' : conc.viaFunds > 0 ? ', mostly held directly.' : ', all held directly.'}
              </p>
            )}
            <RankList rows={stockRows} extra={stockExtra} money={money} label="Exposure by stock" showExtra={showExtra} />
            <Footnote extra={stockExtra} lead="Also in your funds:" tail="— these aren't single stocks." show={showExtra} onToggle={toggleExtra} />
          </>
        )}
      </div>
    </section>
  );
}
