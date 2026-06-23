// Single source of truth for the proxy / substitution shortcuts the allocation
// look-through relies on. The look-through engine (services/fundHoldings.ts)
// reads these maps to do the real work, and the per-page FAQ reads the very
// same maps over /api/meta/assumptions — so the FAQ can never drift from what
// the engine actually does. Add a substitution ONCE, here, and both update.

import { TAX_BUCKETS, type TaxBucket } from './taxBucket.js';

// Blocked-issuer ETFs → closest Vanguard equivalent (same index/style) whose
// holdings ARE reachable. Used as a stand-in for stock look-through only; the
// position's own value is never changed. `label` is human-readable for the FAQ.
export const PROXY_FUND: Record<string, { proxy: string; label: string }> = {
  IVV: { proxy: 'VOO', label: 'iShares S&P 500 → Vanguard S&P 500' },
  SPY: { proxy: 'VOO', label: 'SPDR S&P 500 → Vanguard S&P 500' },
  SCHX: { proxy: 'VV', label: 'Schwab US Large-Cap → Vanguard Large-Cap' },
  ITOT: { proxy: 'VTI', label: 'iShares Total US Market → Vanguard Total US Market' },
  QQQ: { proxy: 'VUG', label: 'Invesco Nasdaq-100 → Vanguard Growth' },
  TQQQ: { proxy: 'VUG', label: 'ProShares 3x Nasdaq-100 → Vanguard Growth (composition; ignores leverage)' },
  IXUS: { proxy: 'VXUS', label: 'iShares Total International → Vanguard Total International' },
  IEMG: { proxy: 'VWO', label: 'iShares Emerging Markets → Vanguard Emerging Markets' },
  SCHF: { proxy: 'VEA', label: 'Schwab International Equity → Vanguard Developed Markets' },
  IWM: { proxy: 'VTWO', label: 'iShares Russell 2000 → Vanguard Russell 2000 (small-cap)' },
  SCHA: { proxy: 'VB', label: 'Schwab US Small-Cap → Vanguard Small-Cap' },
  IJR: { proxy: 'VB', label: 'iShares Core S&P Small-Cap → Vanguard Small-Cap' },
  IJH: { proxy: 'VO', label: 'iShares Core S&P Mid-Cap → Vanguard Mid-Cap' },
};

// Vanguard fund-of-funds (target-date) constituents aren't exposed by the API,
// so map them to their documented underlying funds. Weights from the published
// glide path; equity sleeves are decomposed to stocks, bonds bucketed.
export const FUND_OF_FUNDS: Record<string, {
  label: string;
  constituents: { ticker: string; weight: number; kind: 'equity' | 'bond' }[];
}> = {
  // Vanguard Target Retirement 2055 (~90/10): Total US + Total Intl stocks, Total US + Intl bonds.
  VFFVX: {
    label: 'Vanguard Target Retirement 2055 (~90/10 stocks/bonds)',
    constituents: [
      { ticker: 'VTI', weight: 0.54, kind: 'equity' },
      { ticker: 'VXUS', weight: 0.36, kind: 'equity' },
      { ticker: 'BND', weight: 0.07, kind: 'bond' },
      { ticker: 'BNDX', weight: 0.03, kind: 'bond' },
    ],
  },
  // iShares LifePath Target Date 2040 (~75/25) — proxy for a 529 "Portfolio 2042".
  ITDD: {
    label: 'iShares LifePath 2040 (~75/25) — proxy for a 529 "Portfolio 2042"',
    constituents: [
      { ticker: 'VTI', weight: 0.45, kind: 'equity' },
      { ticker: 'VXUS', weight: 0.30, kind: 'equity' },
      { ticker: 'BND', weight: 0.18, kind: 'bond' },
      { ticker: 'BNDX', weight: 0.07, kind: 'bond' },
    ],
  },
};

// Serializable summary of the assumptions/shortcuts, served to the client FAQ.
// Shapes here are read by client/src/components/PageFaq.tsx.
export interface AssumptionsMeta {
  proxyFunds: { from: string; to: string; label: string }[];
  fundOfFunds: { ticker: string; label: string }[];
  taxBuckets: TaxBucket[];
}

export function buildAssumptionsMeta(): AssumptionsMeta {
  return {
    proxyFunds: Object.entries(PROXY_FUND).map(([from, v]) => ({ from, to: v.proxy, label: v.label })),
    fundOfFunds: Object.entries(FUND_OF_FUNDS).map(([ticker, v]) => ({ ticker, label: v.label })),
    taxBuckets: TAX_BUCKETS,
  };
}
