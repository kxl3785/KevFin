import { useState, useEffect } from 'react';
import type { View } from './TopNav.tsx';
import { useApi } from '../hooks/useApi.ts';
import { MONTE_CARLO_RUNS } from '../lib/forecastConfig.ts';

// Shape served by GET /api/meta/assumptions (server/src/util/assumptions.ts) —
// the same maps the look-through engine uses, so this FAQ can't drift from it.
interface AssumptionsMeta {
  proxyFunds: { from: string; to: string; label: string }[];
  fundOfFunds: { ticker: string; label: string }[];
  taxBuckets: string[];
}

interface FaqEntry { q: string; a: React.ReactNode }
interface PageFaqContent { title: string; intro: string; items: FaqEntry[] }

// Readable names for tax buckets; unknown keys fall back to the raw key so a
// bucket added server-side still renders without a code change here.
const BUCKET_LABELS: Record<string, string> = {
  taxable: 'taxable', pretax: 'pre-tax', roth: 'Roth', hsa: 'HSA', college: '529',
};

const listStyle: React.CSSProperties = { margin: '6px 0 0', paddingLeft: 18, display: 'grid', gap: 3 };

/**
 * Builds the per-page assumptions/shortcuts content. The drift-prone bits — the
 * proxy-fund substitutions, target-date mappings, tax buckets, and Monte Carlo
 * run count — are interpolated from the shared sources (the /api/meta/assumptions
 * payload and lib/forecastConfig.ts) rather than retyped, so the FAQ stays in
 * sync automatically. Prose that explains *how* something works lives here; the
 * specific values it talks about come from `meta`.
 */
function buildFaq(meta: AssumptionsMeta | null): Record<View, PageFaqContent> {
  return {
    dashboard: {
      title: 'Dashboard — assumptions & shortcuts',
      intro: 'How the net-worth headline and history are put together.',
      items: [
        {
          q: 'Where does the history before today come from?',
          a: 'Clicking Backfill reconstructs roughly the last 5 years rather than waiting to accumulate daily snapshots. Cash and credit are rebuilt from transactions, brokerage from each holding’s historical market price, and real estate from your entered Zestimate history. Daily snapshots capture every change going forward.',
        },
        {
          q: 'How are brokerage values reconstructed historically?',
          a: 'Each holding is scaled by its ticker’s historical price (via Stooq). Untickered index funds like 529 portfolios use a proxy ETF, and holdings with no priceable ticker — including crypto — are held flat at their current value.',
        },
        {
          q: 'How is real-estate history estimated?',
          a: 'Zillow exposes no Zestimate history, so where you haven’t entered your own values we use the Zillow Home Value Index (ZHVI) for the property’s ZIP, scaled so its latest point matches the current Zestimate. Manually-entered Zestimate history always takes precedence. Points are interpolated and held flat before the first / after the last.',
        },
        {
          q: 'How is my mortgage balance figured?',
          a: 'When you enter the loan principal, rate, and start date, the balance is computed from a standard amortization schedule server-side instead of being entered by hand. Real-estate value counts as Zestimate minus mortgage balance.',
        },
        {
          q: 'What about manually-added assets?',
          a: 'Manual assets (and crypto) are held flat through the backfill — they show their current value across all historical points, since there’s no price series to reconstruct them from.',
        },
      ],
    },
    allocation: {
      title: 'Investments — assumptions & shortcuts',
      intro: 'How holdings are looked-through and classified.',
      items: [
        {
          q: 'What does "look-through" mean here?',
          a: 'Funds and ETFs are decomposed into their underlying stocks, so sector, country, and stock-exposure views reflect what you actually own — not just the fund tickers. Exposures are aggregated across every account.',
        },
        {
          q: 'Why is one fund shown as a different one (proxy substitution)?',
          a: (
            <>
              Some issuers don’t expose their holdings, so we substitute the closest Vanguard equivalent tracking the same index/style purely for look-through. Your position and its value are unchanged — only the breakdown of what’s inside it is proxied.
              {meta && meta.proxyFunds.length > 0 && (
                <ul style={listStyle}>
                  {meta.proxyFunds.map(p => <li key={p.from}>{p.label}</li>)}
                </ul>
              )}
            </>
          ),
        },
        {
          q: 'How are target-date and 529 funds handled?',
          a: (
            <>
              Fund-of-funds aren’t exposed by the API, so they’re mapped to their documented underlying funds using published glide-path weights; equity sleeves are decomposed to stocks and bond sleeves lumped together.
              {meta && meta.fundOfFunds.length > 0 && (
                <ul style={listStyle}>
                  {meta.fundOfFunds.map(f => <li key={f.ticker}><strong>{f.ticker}</strong> — {f.label}</li>)}
                </ul>
              )}
            </>
          ),
        },
        {
          q: 'How is country/region exposure estimated?',
          a: 'It’s inferred from each underlying holding’s ISIN country code. When no deep holdings source is available for a fund, we fall back to its published top-10 holdings, so smaller positions inside that fund may be under-counted.',
        },
        {
          q: 'How does the performance chart group things?',
          a: 'Performance is grouped by institution rather than by individual account, so accounts at the same firm are combined into one line.',
        },
      ],
    },
    budget: {
      title: 'Budget — assumptions & shortcuts',
      intro: 'How transactions are categorized and recurring items detected.',
      items: [
        {
          q: 'How are transactions categorized?',
          a: 'Each transaction is auto-categorized from its payee and description into a Monarch-style taxonomy. You can override any merchant’s category, and your override is remembered and reapplied to that merchant going forward.',
        },
        {
          q: 'How is "recurring" decided?',
          a: 'Fixed commitments (mortgage, bills) always surface. Flexible items must appear in at least two distinct months and pass a subscription-quality filter (consistent merchant and amount) before they’re counted as recurring — so one-off purchases don’t show up.',
        },
        {
          q: 'How is the monthly amount for a recurring item computed?',
          a: 'It’s the average across the months the merchant appears in, weighting recent activity, so it stays stable and reflects current spending rather than a single month.',
        },
        {
          q: 'Can I import transactions from elsewhere?',
          a: 'Yes — the Import button accepts a CSV (e.g. a Monarch export). Imported rows are categorized the same way as connected-account transactions.',
        },
        {
          q: 'How are account tax types determined?',
          a: (
            <>
              The Forecast model needs tax buckets ({meta ? meta.taxBuckets.map(b => BUCKET_LABELS[b] ?? b).join(' / ') : 'taxable / pre-tax / Roth / HSA / 529'}), but connections only report a coarse type. We infer the bucket best-effort from the account name (e.g. "Roth IRA", "401(k)", "HSA"). It’s a heuristic — reassign any account that’s mislabeled.
            </>
          ),
        },
      ],
    },
    forecast: {
      title: 'Forecast — assumptions & shortcuts',
      intro: 'What the Monte Carlo projection does and doesn’t model.',
      items: [
        {
          q: 'How is the projection computed?',
          a: `It runs a ${MONTE_CARLO_RUNS}-path Monte Carlo. Investment returns are sampled each year from your expected return ± volatility (a normal draw); income, spending, and real-estate growth are deterministic. The shaded band is the 10–90% range of outcomes and the line is the median.`,
        },
        {
          q: 'Are the dollar figures in today’s or future money?',
          a: 'Returns are nominal (before inflation). Income and spending are entered in today’s dollars but grow with inflation each year, so the chart itself is in future (nominal) dollars.',
        },
        {
          q: 'Where do the default income & spending come from?',
          a: 'They’re seeded once from a trailing average of your real transaction data (more stable than a single month). You can re-apply your actual averages, or set inflation to your observed spending trend, from the "Projected from your data" card.',
        },
        {
          q: 'How are kids modeled?',
          a: 'The cost of kids you have today is already baked into your spending, so the model drops spending by the per-kid cost as each child reaches the independence age (the empty-nest effect) rather than adding it on top.',
        },
        {
          q: 'What does "success probability" mean?',
          a: `It’s the share of the ${MONTE_CARLO_RUNS} simulated futures in which your investable assets never hit $0 through your plan horizon. Real-estate equity isn’t counted toward solvency.`,
        },
      ],
    },
  };
}

function QuestionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/**
 * A compact "?" icon button that opens a per-page FAQ explaining the
 * assumptions and shortcuts behind that page's numbers. Lives next to the
 * other TopNav actions so it appears on every page.
 */
export default function PageFaq({ view }: { view: View }) {
  const [open, setOpen] = useState(false);
  // Fetched once and cached by useApi's URL key; shared across every page's button.
  const { data: meta } = useApi<AssumptionsMeta>('/api/meta/assumptions');
  const content = buildFaq(meta)[view];

  // Close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!content) return null;

  return (
    <>
      <button
        className="btn-icon"
        onClick={() => setOpen(true)}
        title="Assumptions & shortcuts for this page"
        aria-label="Assumptions & shortcuts for this page"
      >
        <QuestionIcon />
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: 'rgba(0,0,0,0.55)', display: 'flex',
            alignItems: 'flex-start', justifyContent: 'center',
            padding: '8vh 16px 16px', overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{
              width: '100%', maxWidth: 560,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
              padding: 24,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 4 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>{content.title}</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{ background: 'transparent', color: 'var(--muted)', fontSize: 22, lineHeight: 1, padding: 0, cursor: 'pointer' }}
              >×</button>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>{content.intro}</p>
            <div style={{ display: 'grid', gap: 16 }}>
              {content.items.map(item => (
                <div key={item.q}>
                  <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{item.q}</p>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>{item.a}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
