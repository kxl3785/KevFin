import { useId, useState } from 'react';
import { ASSET_CLASS_META, type RiskProfile } from '../../lib/riskProfiles.ts';
import { investableWeights } from '../../lib/allocationDrift.ts';
import { isCompleteTargets } from '../../lib/allocationTargets.ts';
import { driftPill, movesText } from '../../lib/investments.ts';
import { WorksheetBody } from './RebalanceWorksheet.tsx';
import { CARD, CardHeader, NOTE } from './ui.tsx';
import { META_KEYS, type AllocationStatus } from './useAllocationStatus.ts';
import { useAllocationTargets } from './useAllocationTargets.ts';

// The Investments page's allocation card: the Mix and Rebalance views of the
// earlier page merged into one. One bar per kind of investment with the current
// share filled in, a tick at the target and the ± band around it, "75% of 60%"
// beside it and a pill ("+15 pts" outside the band, "in band" inside). Under the
// bars, one line says what to move; the full rebalance worksheet (new money,
// band, risk profile vs own targets, "Edit your targets") opens below on demand.
// Kinds outside the targets (real estate, private equity, alternatives) are a
// footnote, with the homes' include / exclude chips behind "Show them".
// Clicking a kind lists its holdings in Positions.
//
// The bars count everything the server classes into these kinds, so a manually
// tracked asset classed as, say, Bonds (I Bonds) is in them although the
// "Invested" tile above leaves manual assets out; the subtitle names them.

type Money = (n: number) => string;
interface ClassSlice { name: string; value: number; pct: number }
interface HomeLot { id: number; address: string; equity: number; excluded: boolean }

// Short lower-case names for running text ("U.S. stocks"); the card's bars use
// the same labels as everywhere else on the page.
const metaOf = (key: string) => ASSET_CLASS_META.find(m => m.key === key);
export const classLabel = (key: string) => metaOf(key)?.label ?? key;
const OUTSIDE_LABELS: Record<string, string> = { 'Real Estate': 'real estate', 'Private Equity': 'private equity', Alternatives: 'alternatives', Uncategorized: 'uncategorized', Options: 'options' };
const sentenceLabel = (key: string) => OUTSIDE_LABELS[key] ?? classLabel(key);

// A home chip's accessible name. The chip shows only the address's first part,
// which two homes could share, so the name carries the full address too.
export function homeChipLabel(h: HomeLot, money: Money): string {
  const short = h.address.split(',')[0];
  return `Count ${short} · ${money(h.equity)} in the allocation${h.address !== short ? ` (${h.address})` : ''}`;
}

const pct0 = (p: number) => `${Number.isFinite(p) ? Math.round(p) : 0}%`;
// Shares under 1% keep a decimal so a sliver doesn't read as "0%".
const pctShort = (p: number) => (p > 0 && p < 1 ? `${p.toFixed(1)}%` : pct0(p));

export default function AllocationCard({
  classes, homes, manualInKinds = [], money, status, riskProfile, onOpenRiskProfile, onToggleHome,
  selectedClass, onSelectClass, worksheetOpen, onToggleWorksheet, compact, reserveRight = 0,
}: {
  classes: ClassSlice[];
  homes: HomeLot[];
  /** Manually tracked assets (no account) classed into the targeted kinds: counted in the bars. */
  manualInKinds?: { name: string; value: number }[];
  money: Money;
  status: AllocationStatus;
  riskProfile: RiskProfile | null;
  onOpenRiskProfile: () => void;
  onToggleHome: (id: number, excluded: boolean) => void;
  selectedClass: string | null;
  onSelectClass: (key: string | null) => void;
  worksheetOpen: boolean;
  onToggleWorksheet: () => void;
  /** Card at half width: the worksheet uses its stacked rows. */
  compact: boolean;
  reserveRight?: number;
}) {
  const [showOutside, setShowOutside] = useState(false);
  const worksheetId = useId();
  const outsideId = useId();
  const { result, band, source } = status;
  const compare = !!result && result.comparable;
  // Your own targets are saved but not in use: the worksheet's "Risk profile"
  // is chosen and no risk profile is set. Say that, not "No targets yet".
  const { pref, update } = useAllocationTargets();
  const customIdle = !status.model && isCompleteTargets(pref.custom);

  // Rows: the targeted kinds (with targets, every kind that has a target or a
  // holding; without, every kind held), in the canonical order.
  const weights = investableWeights(Object.fromEntries(classes.map(c => [c.name, c.pct * 100])), META_KEYS);
  const rows = compare
    ? result.rows.map(r => ({ key: r.key, now: r.actualPct, target: r.targetPct as number | null, row: r }))
    : META_KEYS.filter(k => (weights.investablePct[k] ?? 0) > 0.005)
      .map(k => ({ key: k, now: weights.investablePct[k] ?? 0, target: null as number | null, row: null }));

  const outside = classes.filter(c => !META_KEYS.includes(c.name) && c.value > 0.5);
  const excludedHomes = homes.filter(h => h.excluded);

  // What the bars count: investments, plus any manual asset classed into one
  // of these kinds (the "Invested" tile leaves those out).
  const manualTotal = manualInKinds.reduce((t, m) => t + m.value, 0);
  const baseText = !manualInKinds.length ? 'Investments only'
    : `Investments plus ${manualInKinds.length === 1 ? manualInKinds[0].name : `${manualInKinds.length} manual assets`} (${money(manualTotal)})`;

  const title = compare ? (source === 'custom' ? 'Allocation vs your targets' : `Allocation vs the ${riskProfile?.name ?? 'model'} model`) : 'Allocation';
  const at = (p: number) => `${Math.max(0, Math.min(100, p))}%`;

  return (
    <section aria-label="Asset allocation" style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={reserveRight} title={title} tipLabel="Allocation"
        tip="Your investments by kind, against the targets in use. The tick marks each target and the shaded strip the band either side of it. Click a kind to list its holdings in Positions. Read-only: KevFin never places trades."
        controls={(
          <button onClick={onOpenRiskProfile} className="btn-ghost btn-sm"
            title="Answer a few questions to get a recommended target allocation"
            style={{ whiteSpace: 'nowrap', minHeight: 32 }}>
            ✦ {riskProfile ? `Risk: ${riskProfile.name}` : 'Set risk profile'}
          </button>
        )}
        subtitle={`${baseText} · ${compare ? `±${band}-point band` : 'share of what sits in these kinds'}`} />

      {rows.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>No investments to classify yet.</p>
      ) : (
        <div className="inv-alloc" role="list" aria-label="Allocation by kind of investment">
          {rows.map(({ key, now, target, row }) => {
            const pill = row ? driftPill(row, band) : null;
            const sel = selectedClass === key;
            return (
              <div key={key} className="inv-alloc-row" role="listitem">
                <button type="button" className={'inv-alloc-name' + (sel ? ' sel' : '')} aria-pressed={sel}
                  onClick={() => onSelectClass(sel ? null : key)}
                  title={sel ? 'Listed in Positions — click to clear' : 'Click to list these holdings in Positions'}>
                  {classLabel(key)}
                </button>
                <span className="inv-track" aria-hidden="true">
                  {target != null && band > 0 && (
                    <i className="band" style={{ left: at(target - band), width: `calc(${at(target + band)} - ${at(target - band)})` }} />
                  )}
                  <i className="fill" style={{ width: at(now) }} />
                  {target != null && <i className="tick" style={{ left: at(target) }} />}
                </span>
                <span className="inv-alloc-val">
                  {pctShort(now)}{target != null && <small> of {pct0(target)}</small>}
                  {pill && <span className={'inv-pill' + (pill.out ? ' out' : '')}>{pill.text}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {compare ? (
        <p className="inv-callout" style={{ marginTop: 14 }}>
          {movesText(result, money, k => classLabel(k), band)}{' '}
          <button type="button" className="inv-link" aria-expanded={worksheetOpen} aria-controls={worksheetOpen ? worksheetId : undefined}
            onClick={onToggleWorksheet}>
            {worksheetOpen ? 'Hide the worksheet ▾' : 'See the full worksheet ▸'}
          </button>
        </p>
      ) : status.model ? (
        // Targets are set but nothing is invested in these kinds yet.
        <p className="inv-callout" style={{ marginTop: 14 }}>
          {result ? movesText(result, money, k => classLabel(k), band) : 'Nothing is invested in these kinds yet, so there is nothing to compare.'}{' '}
          <button type="button" className="inv-link" aria-expanded={worksheetOpen} aria-controls={worksheetOpen ? worksheetId : undefined}
            onClick={onToggleWorksheet}>
            {worksheetOpen ? 'Hide the worksheet ▾' : 'See the full worksheet ▸'}
          </button>
        </p>
      ) : customIdle && worksheetOpen ? (
        // The worksheet below carries "Use your own targets" / "Set risk profile".
        <p className="inv-callout" style={{ marginTop: 14 }}>
          No risk profile is set, so there is nothing to compare with. Your own targets are saved: switch back to them below.{' '}
          <button type="button" className="inv-link" aria-expanded aria-controls={worksheetId} onClick={onToggleWorksheet}>Hide ▾</button>
        </p>
      ) : customIdle ? (
        <div className="inv-callout" style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ flex: '1 1 220px' }}>No risk profile is set, so there is nothing to compare with. Your own targets are saved.</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => update({ mode: 'custom' })}>Use your own targets</button>
          <button type="button" className="btn-ghost btn-sm" onClick={onOpenRiskProfile}>Set risk profile</button>
        </div>
      ) : worksheetOpen ? (
        // The worksheet below carries its own "Set risk profile / Set your own targets".
        <p className="inv-callout" style={{ marginTop: 14 }}>
          No targets yet: pick them below.{' '}
          <button type="button" className="inv-link" aria-expanded aria-controls={worksheetId} onClick={onToggleWorksheet}>Hide ▾</button>
        </p>
      ) : (
        <div className="inv-callout" style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ flex: '1 1 220px' }}>Set a risk profile or your own targets to see how far each kind sits from them.</span>
          <button type="button" className="btn-ghost btn-sm" onClick={onOpenRiskProfile}>Set risk profile</button>
          <button type="button" className="btn-ghost btn-sm" aria-expanded={false} onClick={onToggleWorksheet}>Set your own targets</button>
        </div>
      )}

      {worksheetOpen && (
        <div id={worksheetId} style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <WorksheetBody classes={classes} homes={homes} money={money} riskProfile={riskProfile}
            onOpenRiskProfile={onOpenRiskProfile} compact={compact} />
        </div>
      )}

      {(outside.length > 0 || homes.length > 0) && (
        <div className="inv-fine">
          {outside.length > 0
            ? <>Not in your targets: {outside.map((c, i) => (
                <span key={c.name}>{i > 0 ? ' · ' : ''}{sentenceLabel(c.name)} {money(c.value)}</span>
              ))}.</>
            : 'No real estate counted.'}
          {excludedHomes.length > 0 && <> {excludedHomes.length === 1 ? '1 home is' : `${excludedHomes.length} homes are`} left out.</>}
          {' '}
          <button type="button" className="inv-link" aria-expanded={showOutside} aria-controls={showOutside ? outsideId : undefined}
            onClick={() => setShowOutside(s => !s)}>{showOutside ? 'Hide them' : 'Show them'}</button>
          {showOutside && (
            <div id={outsideId} style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {homes.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>Real estate:</span>
                  {homes.map(h => {
                    const on = !h.excluded;
                    const short = h.address.split(',')[0];
                    return (
                      <button key={h.id} type="button" aria-pressed={on} aria-label={homeChipLabel(h, money)}
                        onClick={() => onToggleHome(h.id, on)}
                        title={on ? 'Click to exclude this home from the allocation' : 'Click to include this home'}
                        style={{
                          fontSize: 11, padding: '3px 9px', borderRadius: 12, cursor: 'pointer',
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--text)' : 'var(--muted)', opacity: on ? 1 : 0.7,
                        }}>
                        {on ? '✓ ' : '+ '}{short} · {money(h.equity)}
                      </button>
                    );
                  })}
                </div>
              )}
              {outside.length > 0 && (
                <div role="list" aria-label="Kinds outside the targets" style={{ display: 'grid', gap: 2 }}>
                  {outside.map(c => {
                    const sel = selectedClass === c.name;
                    return (
                      <button key={c.name} type="button" role="listitem" className="inv-rank-row muted" aria-pressed={sel}
                        onClick={() => onSelectClass(sel ? null : c.name)} title="Click to list these in Positions"
                        style={sel ? { color: 'var(--accent)' } : undefined}>
                        <span className="inv-rank-label">{classLabel(c.name)}</span>
                        <span className="inv-rank-bar"><i style={{ width: `${Math.min(100, c.pct * 100)}%` }} /></span>
                        <span className="inv-rank-pct">{pctShort(c.pct * 100)}</span>
                        <span className="inv-rank-amt">{money(c.value)}</span>
                      </button>
                    );
                  })}
                  <p style={{ ...NOTE, marginTop: 4 }}>Shares of everything counted here, real estate included.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
