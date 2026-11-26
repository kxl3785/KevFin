import { useId, useState } from 'react';
import { CARD, CardHeader, NOTE, SubHeading } from './ui.tsx';

// Credit quality of the bonds inside the user's funds (Investments page),
// weighted by how many bond dollars each fund holds. Ratings come from each
// fund's published breakdown (Yahoo); funds without one are left out and the
// coverage note says how much that is. Drawn as one stacked bar with a legend,
// in the Dashboard's .db-bar / .db-legend style. Under it, "Held in" lists
// the positions those bond dollars come from and the accounts holding them,
// as a ranked list in the "What you own" card's style.

export interface BondSummary {
  value: number; coverage: number;
  byRating: { name: string; value: number; pct: number }[];
  govShare: number | null; avgDuration: number | null; avgMaturity?: number | null;
  // Largest first. Absent from results stored before it existed: the card
  // then shows no "Held in" list.
  heldIn?: BondHolding[];
}
export interface BondHolding { symbol: string; name: string; value: number; accounts: { name: string; value: number }[] }

// Rows shown before "Show all": a longer list folds to its largest five (six
// or fewer just show, rather than hide a single row behind a button).
const HELD_LIMIT = 5;

// Investment grade (BBB and up) in the accent colour, getting lighter down the
// scale; below investment grade in amber, unrated in muted grey. Never colour
// alone: the legend names each rating and the facts line states the IG share.
const INVESTMENT_GRADE = new Set(['AAA', 'AA', 'A', 'BBB']);
const ORDER = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'Below B', 'Not rated'];
const IG_SHADE: Record<string, number> = { AAA: 100, AA: 72, A: 46, BBB: 26 };

function swatch(name: string): string {
  if (INVESTMENT_GRADE.has(name)) return `color-mix(in srgb, var(--accent) ${IG_SHADE[name]}%, var(--surface-2))`;
  return name === 'Not rated' ? 'var(--muted)' : 'var(--amber)';
}

// "3%" / "0.4%" / "<0.1%": whole percents unless that would hide a sliver.
const share = (p: number) => (p >= 0.01 ? `${Math.round(p * 100)}%` : p >= 0.001 ? `${(p * 100).toFixed(1)}%` : '<0.1%');

export default function BondQuality({ bonds, money, reserveRight = 0 }: { bonds: BondSummary; money: (n: number) => string; reserveRight?: number }) {
  const rated = bonds.byRating.filter(r => r.pct > 0.0005).sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
  const ig = rated.filter(r => INVESTMENT_GRADE.has(r.name)).reduce((s, r) => s + r.pct, 0);
  const facts: string[] = [];
  if (rated.length) facts.push(`${(ig * 100).toFixed(0)}% investment grade`);
  if (bonds.govShare != null) facts.push(`${(bonds.govShare * 100).toFixed(0)}% U.S. government`);
  if (bonds.avgDuration != null) facts.push(`average duration ${bonds.avgDuration.toFixed(1)} years`);
  else if (bonds.avgMaturity != null) facts.push(`average maturity ${bonds.avgMaturity.toFixed(1)} years`);
  return (
    <section aria-label="Bond quality" style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={reserveRight} title="Bond quality"
        tip="Credit ratings of the bonds inside your funds, from each fund's published breakdown. US government bonds are rated AA, so they're counted there too; the US-government share is shown separately. Duration is how much a fund's price moves when rates change: about that many percent per 1-point move. Maturity is how long until the bonds are repaid, on average."
        subtitle={`${money(bonds.value)} of bonds inside your funds, weighted by bond dollars.`} />
      {rated.length === 0 ? (
        <p style={NOTE}>None of your bond funds publish a credit-quality breakdown.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="db-bar" style={{ height: 12 }} role="img"
            aria-label={`Bonds by credit rating: ${rated.map(r => `${r.name} ${share(r.pct)}`).join(', ')}`}>
            {rated.map(r => <i key={r.name} title={`${r.name} · ${share(r.pct)} · ${money(r.value)}`} style={{ width: `${r.pct * 100}%`, background: swatch(r.name) }} />)}
          </span>
          <span className="db-legend">
            {rated.map(r => (
              <span key={r.name} title={money(r.value)}>
                <span className="db-swatch" style={{ background: swatch(r.name) }} />
                {r.name} <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{share(r.pct)}</strong>
                {!INVESTMENT_GRADE.has(r.name) && r.name !== 'Not rated' && <span> (below investment grade)</span>}
              </span>
            ))}
          </span>
        </div>
      )}
      {facts.length > 0 && <p style={{ fontSize: 13, marginTop: 14 }}>{facts.join(' · ')}</p>}
      {bonds.coverage < 0.95 && (
        <p style={{ ...NOTE, marginTop: 8 }}>
          Ratings cover {(bonds.coverage * 100).toFixed(0)}% of your bond holdings; the rest are in funds that don’t publish a breakdown.
        </p>
      )}
      {bonds.heldIn && bonds.heldIn.length > 0 && <HeldIn rows={bonds.heldIn} total={bonds.value} money={money} />}
    </section>
  );
}

// Where the bond dollars sit: each position with its bond dollars, its share of
// all bond dollars (a bar, as in "What you own") and, muted under it, the
// accounts holding it (each account's bond dollars in its tooltip).
function HeldIn({ rows, total, money }: { rows: BondHolding[]; total: number; money: (n: number) => string }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const folds = rows.length > HELD_LIMIT + 1;
  const shown = folds && !all ? rows.slice(0, HELD_LIMIT) : rows;
  return (
    <>
      <SubHeading tip="The funds your bond dollars come from, largest first, with the accounts that hold them. A fund that's only partly bonds (a balanced or target-date fund) counts only its bond part."
        tipLabel="Held in" style={{ margin: '18px 0 6px' }}>Held in</SubHeading>
      <ul id={listId} className="inv-held">
        {shown.map(r => {
          const pct = total > 0 ? r.value / total : 0;
          const label = r.symbol || r.name;
          return (
            <li key={label} className="inv-held-row">
              <span className="inv-rank-label" title={r.symbol && r.name ? `${r.symbol} · ${r.name}` : label}>
                <strong style={{ fontWeight: 600 }}>{label}</strong>
                {r.symbol && r.name && r.name !== r.symbol && <small>{r.name}</small>}
              </span>
              <span className="inv-rank-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, pct * 100)}%` }} /></span>
              <span className="inv-rank-pct">{share(pct)}</span>
              <span className="inv-rank-amt">{money(r.value)}</span>
              {r.accounts.length > 0 && (
                <span className="inv-held-accts">
                  <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>in </span>
                  {r.accounts.map((a, i) => (
                    <span key={a.name} title={`${money(a.value)} of bonds in ${a.name}`}>{i > 0 && ' · '}{a.name}</span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {folds && (
        <button type="button" className="inv-link" aria-expanded={all} aria-controls={listId} onClick={() => setAll(a => !a)} style={{ marginTop: 4 }}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}
