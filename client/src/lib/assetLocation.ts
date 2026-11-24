// Wording for the asset-location table in the Allocation page's fee check-up.
// The server (util/assetLocation.ts) decides WHICH observations apply and how
// many dollars each covers; this turns them into sentences on the client so
// the amount follows the page's privacy masking. Every sentence states where
// something sits and how that account type taxes it — never what to do about it.

export type LocationBucket = 'taxable' | 'pretax' | 'roth' | 'hsa' | 'college';
export type LocationObservationKind = 'bonds-taxable' | 'reits-taxable' | 'foreign-sheltered';
export interface LocationObservation { kind: LocationObservationKind; amount: number }

export const LOCATION_BUCKET_LABELS: Record<LocationBucket, { label: string; hint: string }> = {
  taxable: { label: 'Taxable', hint: 'Regular brokerage accounts: interest, dividends and sold gains are taxed each year.' },
  pretax: { label: 'Pre-tax', hint: '401(k), 403(b), traditional IRA: no tax on growth until withdrawal, then taxed as income.' },
  roth: { label: 'Roth', hint: 'Roth IRA / Roth 401(k): growth and qualified withdrawals are tax-free.' },
  hsa: { label: 'HSA', hint: 'Health savings account: tax-free for qualified medical costs.' },
  college: { label: 'College', hint: '529 and other education savings: tax-free for qualified education costs.' },
};

export function bucketLabel(b: string): string {
  return (LOCATION_BUCKET_LABELS as Record<string, { label: string }>)[b]?.label ?? b;
}

// One neutral sentence per observation. `money` is the page's formatter (it
// returns a mask in privacy mode). Unknown kinds (a newer server) are skipped.
export function observationText(o: LocationObservation, money: (n: number) => string): string | null {
  const amt = money(o.amount);
  switch (o.kind) {
    case 'bonds-taxable':
      return `${amt} of bonds sit in taxable accounts, where their interest is taxed each year.`;
    case 'reits-taxable':
      return `${amt} of real-estate funds sit in taxable accounts, where most of their payouts are taxed as ordinary income each year.`;
    case 'foreign-sheltered':
      return `${amt} of foreign stock sits in tax-advantaged accounts, where the credit for taxes withheld abroad can't be claimed.`;
    default:
      return null;
  }
}
