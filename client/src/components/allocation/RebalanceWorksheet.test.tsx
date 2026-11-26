import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorksheetBody } from './RebalanceWorksheet.tsx';
import TargetsEditor from './TargetsEditor.tsx';
import { RISK_PROFILES } from '../../lib/riskProfiles.ts';

// Static renders (no DOM in this test setup): enough to check what the
// worksheet puts on screen and the names its controls carry.
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const body = (classes: { name: string; value: number }[], money = usd) => renderToStaticMarkup(
  <WorksheetBody classes={classes} homes={[]} money={money} riskProfile={RISK_PROFILES.moderate} onOpenRiskProfile={() => {}} />,
);

describe('RebalanceWorksheet', () => {
  it('gives every control an accessible name (COORD-4)', () => {
    const html = body([{ name: 'Domestic Stock', value: 1000 }]);
    expect(html).toContain('aria-label="Risk profile: Moderate"');
    expect(html).toContain('aria-label="Your own targets"');
    expect(html).toContain('aria-label="Band either side of each target"');
    expect(html).toContain('aria-label="New money to add (optional), in dollars"');
    expect(html).toMatch(/<legend[^>]*>Compare with<\/legend>/);
    // Radio labels don't wrap inside themselves.
    expect(html).toMatch(/<label style="[^"]*white-space:nowrap[^"]*"><input[^>]*type="radio"/);
  });

  it('shows "Under $1", never "−$0", on a tiny total (RBUI-5)', () => {
    const html = body([{ name: 'Domestic Stock', value: 1 }]);
    expect(html).toContain('Under $1');
    expect(html).not.toContain('−$0');
  });

  it('notes a kind that nets below zero and is counted as zero (RB-3)', () => {
    const html = body([{ name: 'Domestic Stock', value: 100_000 }, { name: 'Bonds', value: 50_000 }, { name: 'Short Term', value: -10_000 }]);
    expect(html).toMatch(/\(−\$10,000\)<\/span> is below zero, perhaps a margin balance, so the worksheet counts it as zero, as do the bars above\./);
    // Masked in privacy mode like every other figure.
    const masked = body([{ name: 'Domestic Stock', value: 100_000 }, { name: 'Short Term', value: -10_000 }], () => '••••••');
    expect(masked).toContain('(−••••••)');
    expect(masked).not.toContain('$10,000');
    // No note when nothing is negative.
    expect(body([{ name: 'Domestic Stock', value: 100_000 }])).not.toContain('below zero');
  });

  it('shows two decimals for a row just past the band edge (RB-2)', () => {
    // Moderate: Domestic 38% and Bonds 30% of the compared total. 43,040 / 56,960
    // puts Domestic at 43.04%, 5.04 points above a ±5 band.
    const html = body([{ name: 'Domestic Stock', value: 43_040 }, { name: 'Bonds', value: 56_960 }]);
    expect(html).toContain('43.04% now');
    expect(html).toContain('5.04 points above');
  });
});

describe('TargetsEditor', () => {
  it('names each target box after its kind (COORD-4)', () => {
    const html = renderToStaticMarkup(<TargetsEditor initial={{}} riskProfile={null} onSave={() => {}} onCancel={() => {}} />);
    expect(html).toContain('aria-label="U.S. Stocks target, in percent"');
    expect((html.match(/target, in percent"/g) ?? []).length).toBe(6);
  });
});
