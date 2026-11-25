import { CARD, CardHeader, NOTE } from './ui.tsx';

// Credit quality of the bonds inside the user's funds (Investments page),
// weighted by how many bond dollars each fund holds. Ratings come from each
// fund's published breakdown (Yahoo); funds without one are left out and the
// coverage note says how much that is.

export interface BondSummary {
  value: number; coverage: number;
  byRating: { name: string; value: number; pct: number }[];
  govShare: number | null; avgDuration: number | null; avgMaturity?: number | null;
}

// Investment grade (BBB and up) in the accent colour, getting lighter down the
// scale; below investment grade in amber.
const INVESTMENT_GRADE = new Set(['AAA', 'AA', 'A', 'BBB']);
const ORDER = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'Below B', 'Not rated'];

export default function BondQuality({ bonds, money }: { bonds: BondSummary; money: (n: number) => string }) {
  const rated = bonds.byRating.filter(r => r.pct > 0.0005);
  const ig = rated.filter(r => INVESTMENT_GRADE.has(r.name)).reduce((s, r) => s + r.pct, 0);
  const facts: string[] = [];
  if (rated.length) facts.push(`${(ig * 100).toFixed(0)}% investment grade`);
  if (bonds.govShare != null) facts.push(`${(bonds.govShare * 100).toFixed(0)}% US government`);
  if (bonds.avgDuration != null) facts.push(`average duration ${bonds.avgDuration.toFixed(1)} years`);
  else if (bonds.avgMaturity != null) facts.push(`average maturity ${bonds.avgMaturity.toFixed(1)} years`);
  return (
    <div style={{ ...CARD, height: '100%', boxSizing: 'border-box' }}>
      <CardHeader reserveRight={16} title="Bond Quality"
        tip="Credit ratings of the bonds inside your funds, from each fund's published breakdown. US government bonds are rated AA, so they're counted there too; the US-government share is shown separately. Duration is how much a fund's price moves when rates change: about that many percent per 1-point move. Maturity is how long until the bonds are repaid, on average."
        subtitle={`The bonds inside your funds · ${money(bonds.value)} of bonds, weighted by bond dollars.`} />
      {facts.length > 0 && <p style={{ fontSize: 13, marginBottom: 14 }}>{facts.join(' · ')}</p>}
      {rated.length === 0 ? (
        <p style={NOTE}>None of your bond funds publish a credit-quality breakdown.</p>
      ) : (
        <div role="list" aria-label="Bonds by credit rating">
          {[...rated].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)).map((r, i) => {
            const ok = INVESTMENT_GRADE.has(r.name);
            return (
              <div key={r.name} role="listitem" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                  <span>{r.name}{!ok && r.name !== 'Not rated' && <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>below investment grade</span>}</span>
                  <span style={{ color: 'var(--muted)' }}>{money(r.value)} · {(r.pct * 100).toFixed(1)}%</span>
                </div>
                <div style={{ height: 8, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, r.pct * 100)}%`, height: '100%',
                    background: ok ? 'var(--accent)' : 'var(--amber)', opacity: ok ? Math.max(0.45, 1 - i * 0.15) : 0.85,
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {bonds.coverage < 0.95 && (
        <p style={{ ...NOTE, marginTop: 12 }}>
          Ratings cover {(bonds.coverage * 100).toFixed(0)}% of your bond holdings; the rest are in funds that don’t publish a breakdown.
        </p>
      )}
    </div>
  );
}
