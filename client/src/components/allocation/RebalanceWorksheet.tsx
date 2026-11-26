import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ASSET_CLASS_META, type RiskProfile } from '../../lib/riskProfiles.ts';
import { BAND_CHOICES, effectiveTargets, isCompleteTargets } from '../../lib/allocationTargets.ts';
import {
  rebalance, newMoneySplit, driftDisplay, deltaText, newMoneyHelp, negativeClasses, parseNewMoney,
} from '../../lib/rebalance.ts';
import { useAllocationTargets } from './useAllocationTargets.ts';
import TargetsEditor from './TargetsEditor.tsx';
import InfoTip from './InfoTip.tsx';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { FOOTER, NOTE, NUM } from './ui.tsx';

// Read-only rebalancing worksheet: the fold-out "full worksheet" of the
// allocation card on the Investments page. For each kind of investment, how far the current
// share sits from its target and the dollar amount that would bring it back —
// or, given some new money, how that money would split to move toward the
// targets without selling anything. Targets come from the risk profile or from
// the user's own (set here). Amounts per asset class only: KevFin never places
// trades.
//
// Like the bars on the allocation card, only the investable classes
// the targets cover are compared (renormalised to 100% of themselves); real
// estate and other assets sit outside the targets and are listed in a note.
// Homes switched off on the allocation card are not counted at all, because the server
// already leaves them out of byAssetClass.

type Money = (n: number) => string;
interface ClassSlice { name: string; value: number }
interface HomeLot { id: number; address: string; equity: number; excluded: boolean }

const META_KEYS = ASSET_CLASS_META.map(m => m.key as string);
const metaOf = (key: string) => ASSET_CLASS_META.find(m => m.key === key);
const labelOf = (key: string) => metaOf(key)?.label ?? key;
const OUTSIDE_LABELS: Record<string, string> = { 'Real Estate': 'Real estate', 'Private Equity': 'Private equity' };

// "12.3%" — one decimal, never NaN.
const pctText = (p: number) => `${Number.isFinite(p) ? p.toFixed(1) : '0.0'}%`;
// Targets are whole or one-decimal numbers; show them without a trailing ".0".
const targetText = (p: number) => `${Number.isFinite(p) ? Number(p.toFixed(1)) : 0}%`;
// Visually hidden but read by screen readers.
const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

// Bar scale: the widest of any current share or target-plus-band on screen,
// rounded up to the next 10 points (at least 10, at most 100), so small classes
// still have a readable bar and the band always fits.
function barScale(rows: { actualPct: number; targetPct: number }[], band: number): number {
  const m = Math.max(0, ...rows.map(r => Math.max(r.actualPct, r.targetPct + band)));
  return Math.min(100, Math.max(10, Math.ceil(m / 10) * 10));
}

function DriftBar({ actualPct, targetPct, band, scale, color, afterPct }: {
  actualPct: number; targetPct: number; band: number; scale: number; color: string; afterPct?: number;
}) {
  const at = (p: number) => `${Math.max(0, Math.min(100, (p / scale) * 100))}%`;
  const lo = Math.max(0, targetPct - band), hi = Math.min(scale, targetPct + band);
  return (
    <div aria-hidden="true" style={{ position: 'relative', height: 16 }}>
      {/* Track */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 5, height: 6, background: 'var(--bg)', borderRadius: 3 }} />
      {/* Band either side of the target */}
      {band > 0 && (
        <div style={{ position: 'absolute', left: at(lo), width: `calc(${at(hi)} - ${at(lo)})`, top: 1, height: 14, background: 'var(--accent-dim)', borderLeft: '1px dashed var(--accent)', borderRight: '1px dashed var(--accent)', boxSizing: 'border-box', borderRadius: 2 }} />
      )}
      {/* After the new money (outline), then now (solid) */}
      {afterPct != null && (
        <div style={{ position: 'absolute', left: 0, width: at(afterPct), top: 4, height: 8, border: `1.5px dashed ${color}`, borderRadius: 3, boxSizing: 'border-box' }} />
      )}
      <div style={{ position: 'absolute', left: 0, width: at(actualPct), top: 5, height: 6, background: color, borderRadius: 3 }} />
      {/* Target tick */}
      <div style={{ position: 'absolute', left: `calc(${at(targetPct)} - 1px)`, top: 0, width: 2, height: 16, background: 'var(--text)', borderRadius: 1 }} />
    </div>
  );
}

// "Outside band" (amber) or "In band" (quiet): readable at a glance, never
// colour alone.
function StatusPill({ inBand }: { inBand: boolean }) {
  return (
    <span style={{
      fontSize: 12, fontWeight: 600, lineHeight: '18px', padding: '0 8px', borderRadius: 9, whiteSpace: 'nowrap',
      color: inBand ? 'var(--muted)' : 'var(--amber)',
      border: `1px solid ${inBand ? 'var(--border)' : 'var(--amber)'}`,
    }}>{inBand ? 'In band' : 'Outside band'}</span>
  );
}

// A figure over a short muted caption, right-aligned so the dollar amounts
// line up down the list.
function Amount({ value, caption, strong = true, muted = false }: { value: React.ReactNode; caption?: React.ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <span style={{ display: 'block', ...NUM }}>
      <span style={{ display: 'block', fontSize: 14, fontWeight: strong ? 600 : 400, color: muted ? 'var(--muted)' : 'var(--text)' }}>{value}</span>
      {caption && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{caption}</span>}
    </span>
  );
}

export function WorksheetBody({ classes, homes, money, riskProfile, onOpenRiskProfile, compact = false }: {
  classes: ClassSlice[]; homes: HomeLot[]; money: Money;
  riskProfile: RiskProfile | null; onOpenRiskProfile: () => void;
  /** Narrow container (the card at half width): use the stacked phone rows. */
  compact?: boolean;
}) {
  const { pref, update } = useAllocationTargets();
  const [editing, setEditing] = useState(false);
  const [newMoneyText, setNewMoneyText] = useState('');
  const ids = useId();
  // Stacked rows on a phone, or when the card is only half the page wide: the
  // three-column row needs about 560px.
  const stacked = useIsMobile() || compact;

  // Focus: the button that opens the editor unmounts on the same click, so on
  // close (Save, Cancel or Escape) focus goes back to whichever opener is still
  // on screen — the one used, else "Edit your targets", else the radio.
  const editBtnRef = useRef<HTMLButtonElement>(null);
  const emptyBtnRef = useRef<HTMLButtonElement>(null);
  const customRadioRef = useRef<HTMLInputElement>(null);
  const opener = useRef<'edit' | 'empty' | 'radio'>('edit');
  const returnFocus = useRef(false);
  const openEditor = (from: 'edit' | 'empty' | 'radio') => { opener.current = from; setEditing(true); };
  const closeEditor = () => { returnFocus.current = true; setEditing(false); };
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    const used = { edit: editBtnRef, empty: emptyBtnRef, radio: customRadioRef }[opener.current].current;
    (used ?? editBtnRef.current ?? customRadioRef.current)?.focus();
  }, [editing]);

  const { model, source } = effectiveTargets(pref, riskProfile);
  const customSaved = isCompleteTargets(pref.custom);
  const band = pref.band;

  // Current dollars per targeted class (classes outside the targets are left out).
  const values = useMemo(() => {
    const v: Record<string, number> = {};
    for (const c of classes) if (META_KEYS.includes(c.name)) v[c.name] = (v[c.name] ?? 0) + c.value;
    return v;
  }, [classes]);
  const outside = classes.filter(c => !META_KEYS.includes(c.name) && c.value > 0.5);
  // Kinds that net below zero (e.g. a margin balance): counted as $0 here.
  const negatives = negativeClasses(values, META_KEYS);

  // Parsed strictly, so "10k" or "1e6" is an error rather than $10 or $16.
  const newMoneyParsed = parseNewMoney(newMoneyText);
  const newMoneyError = newMoneyParsed && 'error' in newMoneyParsed ? newMoneyParsed.error : null;
  const newMoney = newMoneyParsed && 'value' in newMoneyParsed ? Math.round(newMoneyParsed.value) : 0;

  const result = model ? rebalance(values, model, band, META_KEYS) : null;
  const split = model && newMoney > 0 ? newMoneySplit(values, model, newMoney, META_KEYS) : null;
  const scale = result ? barScale(result.rows.map(r => ({ actualPct: r.actualPct, targetPct: r.targetPct })), band) : 100;
  const outOfBand = result ? result.rows.filter(r => !r.inBand).length : 0;

  function chooseCustom() {
    if (customSaved) update({ mode: 'custom' });
    else openEditor('radio'); // nothing saved yet: the mode switches on save
  }

  // Labels keep their natural width (no wrapping inside a label); the whole
  // group wraps to a new line instead when the row runs out of room.
  const radio = (checked: boolean, label: string, onChange: () => void, ref?: React.Ref<HTMLInputElement>) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 32 }}>
      <input ref={ref} type="radio" name={`${ids}-src`} checked={checked} onChange={onChange} aria-label={label} />
      {label}
    </label>
  );

  // Per-class rows: name, status and drift on the left, the bar in the middle,
  // the amount right-aligned. On a phone: name + amount, then bar, then drift.
  const rowGrid: React.CSSProperties = stacked
    ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gridTemplateAreas: '"name amount" "bar bar" "detail detail"', columnGap: 12, rowGap: 6, alignItems: 'center' }
    : { display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) minmax(120px, 1fr) minmax(150px, 200px)', gridTemplateAreas: '"name bar amount" "detail bar amount"', columnGap: 24, rowGap: 2, alignItems: 'center' };

  return (
    <div>
      {/* Which targets, and how much leeway: one control row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 24px', alignItems: 'center', paddingBottom: 12, marginBottom: 14, borderBottom: '1px solid var(--border)' }}>
        <fieldset style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
          <legend style={srOnly}>Compare with</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', alignItems: 'center' }}>
            <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>Compare with</span>
            {radio(pref.mode !== 'custom' || !customSaved,
              riskProfile ? `Risk profile: ${riskProfile.name}` : 'Risk profile (not set)',
              () => update({ mode: 'profile' }))}
            {radio(pref.mode === 'custom' && customSaved, 'Your own targets', chooseCustom, customRadioRef)}
          </div>
        </fieldset>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, whiteSpace: 'nowrap', minHeight: 32 }}>
          <label htmlFor={`${ids}-band`} style={{ color: 'var(--muted)', fontSize: 12 }}>Band either side</label>
          <select id={`${ids}-band`} aria-label="Band either side of each target" value={String(band)} onChange={e => update({ band: Number(e.target.value) })}>
            {(BAND_CHOICES.includes(band) ? BAND_CHOICES : [...BAND_CHOICES, band].sort((a, b) => a - b)).map(b => (
              <option key={b} value={String(b)}>±{b} {b === 1 ? 'point' : 'points'}</option>
            ))}
          </select>
          <InfoTip text="Often called a tolerance or rebalancing band: how far a kind of investment can drift from its target, in percentage points either way, before it's flagged as outside. With a 40% target and ±5 points, anything from 35% to 45% counts as in band." />
        </span>
        {(pref.mode === 'custom' || customSaved) && !editing && (
          <button ref={editBtnRef} type="button" className="btn-ghost btn-sm" onClick={() => openEditor('edit')}
            style={{ marginLeft: 'auto', minHeight: 32 }}>Edit your targets</button>
        )}
      </div>

      {editing && (
        <TargetsEditor
          initial={pref.custom}
          riskProfile={riskProfile}
          onCancel={closeEditor}
          onSave={custom => { update({ custom, mode: 'custom' }); closeEditor(); }}
        />
      )}

      {pref.mode === 'custom' && !customSaved && (
        <p style={{ ...NOTE, marginBottom: 12, borderLeft: '3px solid var(--amber)', paddingLeft: 10 }}>
          Your saved targets don't add up to 100%, so {riskProfile ? 'the risk profile is used instead' : 'there is nothing to compare with yet'}. Use “Edit your targets” to fix them.
        </p>
      )}

      {!model || !result ? (
        !editing && (customSaved ? (
          // Your own targets exist but aren't in use (the risk profile is
          // chosen and not set): offer them back, not "set your own targets",
          // which would sit beside "Edit your targets" above.
          <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <span style={{ maxWidth: '72ch' }}>No risk profile is set, so there is nothing to compare with. Switch back to your own targets, or set a risk profile.</span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => update({ mode: 'custom' })}>Use your own targets</button>
            <button type="button" className="btn-ghost btn-sm" onClick={onOpenRiskProfile}>Set risk profile</button>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <span style={{ maxWidth: '72ch' }}>Pick a risk profile or set your own targets to see how far each kind sits from them.</span>
            <button type="button" className="btn-ghost btn-sm" onClick={onOpenRiskProfile}>Set risk profile</button>
            <button ref={emptyBtnRef} type="button" className="btn-ghost btn-sm" onClick={() => openEditor('empty')}>Set your own targets</button>
          </div>
        ))
      ) : (
        <>
          {/* Summary on the left, the optional new-money box on the right */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
            <p style={{ fontSize: 14, fontWeight: 600, paddingTop: 6 }}>
              {!result.comparable
                ? 'Nothing is invested in these kinds yet, so there is nothing to compare.'
                : outOfBand === 0
                  ? `Every kind sits within ±${band} ${band === 1 ? 'point' : 'points'} of ${source === 'custom' ? 'your targets' : 'the model'}.`
                  : `${outOfBand} of ${result.rows.length} kinds sit outside the ±${band}-point band.`}
            </p>

            {/* New money: switches the amounts to an add-only split */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: stacked ? 'flex-start' : 'flex-end' }}>
              <label htmlFor={`${ids}-new`} style={{ fontSize: 12, color: 'var(--muted)' }}>New money to add (optional)</label>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span aria-hidden="true" style={{ fontSize: 13, color: 'var(--muted)' }}>$</span>
                <input id={`${ids}-new`} value={newMoneyText} onChange={e => setNewMoneyText(e.target.value)}
                  aria-label="New money to add (optional), in dollars"
                  inputMode="decimal" placeholder="e.g. 10,000" autoComplete="off"
                  aria-invalid={!!newMoneyError} aria-describedby={`${ids}-new-help`}
                  style={{ width: 120, padding: '6px 10px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', background: 'var(--bg)', border: `1px solid ${newMoneyError ? 'var(--red)' : 'var(--border)'}`, borderRadius: 8, color: 'var(--text)' }} />
              </span>
              {newMoneyText && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => setNewMoneyText('')}>Clear</button>
              )}
            </div>
          </div>
          <p id={`${ids}-new-help`} style={{ ...NOTE, color: newMoneyError ? 'var(--red)' : 'var(--muted)', marginBottom: 10, marginLeft: stacked ? 0 : 'auto', textAlign: stacked ? 'left' : 'right' }}>
            {newMoneyError ?? (split
              ? newMoneyHelp(split, money, labelOf)
              : 'Enter an amount to see how it would split across the kinds without selling anything.')}
          </p>

          <ul aria-label={split ? 'Split of new money by kind of investment' : 'Drift from target by kind of investment'}
            style={{ listStyle: 'none', padding: 0, margin: 0, borderTop: '1px solid var(--border)' }}>
            {result.rows.map(r => {
              const meta = metaOf(r.key);
              const color = meta?.color ?? '#7b7f95';
              const s = split?.rows.find(x => x.key === r.key);
              // Two decimals for a row just past the band edge, so "5 points
              // above" never sits next to "Outside band" on a ±5 band.
              const { nowText, driftText } = driftDisplay(r, band);
              let amount: React.ReactNode;
              if (s) {
                amount = s.add > 0
                  ? <Amount value={`+${money(s.add)}`} caption="of new money" />
                  : <Amount value="None" caption="of the new money" strong={false} muted />;
              } else if (!result.comparable) {
                amount = null;
              } else if (r.inBand) {
                amount = r.delta !== 0
                  ? <Amount value={deltaText(r.delta, money)} caption="to exact target" strong={false} muted />
                  : null;
              } else {
                amount = <Amount value={deltaText(r.delta, money)} caption="to get back" />;
              }
              return (
                <li key={r.key} style={{ ...rowGrid, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ gridArea: 'name', minWidth: 0, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                    {labelOf(r.key)}
                    {result.comparable && !s && <StatusPill inBand={r.inBand} />}
                  </span>
                  <span style={{ gridArea: 'amount', minWidth: 0 }}>{amount}</span>
                  <span style={{ gridArea: 'bar', minWidth: 0 }}>
                    <DriftBar actualPct={r.actualPct} targetPct={r.targetPct} band={band} scale={scale} color={color} afterPct={s?.afterPct} />
                  </span>
                  <p style={{ gridArea: 'detail', fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', paddingLeft: stacked ? 0 : 18 }}>
                    {nowText} now · target {targetText(r.targetPct)}
                    {result.comparable && <> · {driftText}</>}
                    {s && <> · {pctText(s.afterPct)} after</>}
                  </p>
                </li>
              );
            })}
          </ul>
          <p aria-hidden="true" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, display: 'flex', gap: '4px 14px', flexWrap: 'wrap', alignItems: 'center', justifyContent: stacked ? 'flex-start' : 'flex-end' }}>
            <span><span style={{ display: 'inline-block', width: 12, height: 5, background: 'var(--muted)', borderRadius: 3, verticalAlign: 'middle', marginRight: 4 }} />now</span>
            {split && <span><span style={{ display: 'inline-block', width: 12, height: 7, border: '1.5px dashed var(--muted)', borderRadius: 3, verticalAlign: 'middle', boxSizing: 'border-box', marginRight: 4 }} />after the new money</span>}
            <span><span style={{ display: 'inline-block', width: 2, height: 10, background: 'var(--text)', verticalAlign: 'middle', marginRight: 4 }} />target</span>
            {band > 0 && <span><span style={{ display: 'inline-block', width: 12, height: 9, background: 'var(--accent-dim)', borderLeft: '1px dashed var(--accent)', borderRight: '1px dashed var(--accent)', verticalAlign: 'middle', boxSizing: 'border-box', marginRight: 4 }} />band</span>}
            <span>Bars run from 0 to {scale}%.</span>
          </p>

          {negatives.length > 0 && (
            <p style={{ ...NOTE, marginTop: 12 }}>
              {negatives.map((c, i) => (
                <span key={c.key}>
                  {i > 0 ? (i === negatives.length - 1 ? ' and ' : ', ') : ''}
                  {labelOf(c.key)} (−{money(Math.abs(c.value))})
                </span>
              ))}
              {' '}{negatives.length === 1 ? 'is' : 'are'} below zero, perhaps a margin balance, so the worksheet counts {negatives.length === 1 ? 'it' : 'them'} as zero, as do the bars above.
            </p>
          )}

          {(outside.length > 0 || homes.some(h => h.excluded)) && (
            <p style={{ ...NOTE, marginTop: 12 }}>
              {outside.length > 0 && (
                <>
                  {outside.map((c, i) => (
                    <span key={c.name}>
                      {i > 0 ? (i === outside.length - 1 ? ' and ' : ', ') : ''}
                      {OUTSIDE_LABELS[c.name] ?? c.name} ({money(c.value)})
                    </span>
                  ))}
                  {' '}{outside.length === 1 ? 'sits' : 'sit'} outside the targets, so the worksheet leaves {outside.length === 1 ? 'it' : 'them'} out, the same as the bars above.{' '}
                </>
              )}
              {homes.some(h => h.excluded) && 'Homes switched off under “Show them” are not counted at all.'}
            </p>
          )}
        </>
      )}

      <p style={FOOTER}>
        Estimates for planning, not advice. Amounts per asset class only; they leave out taxes, trading costs and which account each amount would sit in. KevFin never places trades.
      </p>
    </div>
  );
}
