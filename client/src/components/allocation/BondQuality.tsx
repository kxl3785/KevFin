import { CARD, CardHeader, NOTE } from './ui.tsx';

// Credit quality of the bonds inside the user's funds (Investments page),
// weighted by how many bond dollars each fund holds. Ratings come from each
// fund's published breakdown (Yahoo); funds without one are left out and the
// coverage note says how much that is. Drawn as one stacked bar with a legend,
// in the Dashboard's .db-bar / .db-legend style.

export interface BondSummary {
  value: number; coverage: number;
  byRating: { name: string; value: number; pct: number }[];
  govShare: number | null; avgDuration: number | null; avgMaturity?: number | null;
}

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
    </section>
  );
}
