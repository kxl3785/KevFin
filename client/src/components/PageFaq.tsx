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
      title: 'Dashboard: how it works',
      intro: 'How the net-worth headline and history are put together.',
      items: [
        {
          q: 'Where does the history before today come from?',
          a: 'Rebuild history (the ⋯ menu on the History chart) reconstructs roughly the last 5 years rather than waiting to accumulate daily history points. Cash and credit are rebuilt from transactions, brokerage from each holding’s historical market price, and real estate from your entered Zestimate history. Daily history points capture every change going forward.',
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
      title: 'Investments: how it works',
      intro: 'How holdings are looked-through and classified.',
      items: [
        {
          q: 'What does "look-through" mean here?',
          a: 'Funds and ETFs are decomposed into their underlying stocks, so sector, country, and stock-exposure views reflect what you actually own — not just the fund tickers. Exposures are aggregated across every account.',
        },
        {
          q: 'Where do a fund’s holdings come from, and how fresh are they?',
          a: 'Vanguard funds and US-stock SPDR ETFs use the fund company’s own published holdings (current). Every other US-registered fund uses its latest quarterly N-PORT filing from SEC EDGAR, so those holdings can lag a few months — fine for allocation, since fund composition drifts slowly. EDGAR filings identify stocks by CUSIP and name rather than ticker; KevFin looks tickers up through OpenFIGI in the background, so a company may show under its name for one visit before its symbol appears. Only public fund and security identifiers are sent, never anything about your positions.',
        },
        {
          q: 'What about bonds and cash inside a fund?',
          a: 'A fund’s stock / bond / cash split comes from its filing or its published breakdown, so a 60/40 fund counts as 60% stocks and 40% bonds in Asset Allocation, and its sector weights cover only the stock part. Bond Quality shows the credit ratings of the bonds inside your funds, where funds publish them.',
        },
        {
          q: 'A holding has no ticker or no data (a 401(k) trust, a 529 portfolio). What can I do?',
          a: 'Open its row in Your Positions and describe what it tracks — one fund (“VFFVX”) or a mix from your plan’s fact sheet (“VTI 60, BND 40”). The breakdown and price history then follow that description instead of KevFin’s guess. A ◇ next to a name marks a holding KevFin can’t see inside.',
        },
        {
          q: 'Why is one fund shown as a different one (proxy substitution)?',
          a: (
            <>
              When neither the fund company nor an EDGAR filing is reachable, we fall back to the closest Vanguard equivalent tracking the same index/style purely for look-through. Your position and its value are unchanged — only the breakdown of what’s inside it is proxied.
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
              A fund that holds other funds is looked through one level down: each underlying fund (from the fund’s published top holdings or its filing) is decomposed to stocks, and underlying bond funds become bonds. If that information isn’t available, a few are mapped to their documented underlying funds using published glide-path weights. Untickered 529 portfolios use a stand-in fund unless you describe them yourself.
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
        {
          q: 'Can I set my own target mix instead of a risk profile?',
          a: 'Yes. In the Asset Allocation card, switch to Rebalance and choose “Your own targets”, then type the share you want in each kind of investment. It only saves when the shares add up to exactly 100%. Your targets then replace the risk profile’s model in both the Mix and Rebalance views; switch back to the risk profile at any time and your own targets stay saved.',
        },
        {
          q: 'What does the Rebalance view show?',
          a: 'For each kind of investment: its share now, its target, how many points apart they are, and whether that is inside the band you picked (5 points either side unless you change it). Outside the band, it shows the dollar amount that would bring that kind back to target; the amounts add up to zero. Enter some new money and it shows instead how that money would split to move toward the targets without selling anything. As in the Mix view, only the kinds the targets cover are compared, so real estate and other assets are left out. These are amounts per asset class only; KevFin never places trades, and they leave out taxes and trading costs. Estimates for planning, not advice.',
        },
        {
          q: 'Where do the fund fees in the fee check-up come from?',
          a: 'When you open the check-up, each fund’s yearly fee (its expense ratio) is looked up from published fund data by ticker symbol only — no balances or account details are sent — and kept for about a month. Single stocks and cash count as no fee. A fund with no published figure is shown as unknown and left out of the totals rather than guessed; you can type in the figure from the fund’s fact sheet, and your figure always wins.',
        },
        {
          q: 'How is “fees over N years” worked out?',
          a: 'It takes the holdings with a known fee and grows each one twice over the Forecast’s horizon (your current age on the Forecast to its end age) — once at the Forecast’s expected return and once at that return minus that fund’s own fee — with no new money added, then adds up the gaps in today’s dollars using the Forecast’s inflation. It’s an estimate for planning, not advice.',
        },
        {
          q: 'What does the “where your investments sit” table show?',
          a: 'Your brokerage and retirement holdings split by kind (stocks, bonds, and so on) and by account tax type — taxable, pre-tax, Roth, HSA and college — using the same account types as the Forecast, including any you reassigned there. The notes under it only describe where things are and how that account type is taxed; they are not suggestions to buy, sell or move anything.',
        },
      ],
    },
    budget: {
      title: 'Budget: how it works',
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
          a: 'Yes. The import button in the top bar accepts a CSV (e.g. a Monarch export). Imported rows are categorized the same way as transactions from connected accounts.',
        },
        {
          q: 'What happens to documents I import?',
          a: 'The import button in the top bar reads a statement, receipt, or tax return and proposes entries for you to review and edit. KevFin then deletes the file; only the entries you confirm are saved.',
        },
        {
          q: 'My bank’s CSV has different columns. Can I still import it?',
          a: 'Yes. In Setup, choose “Import transactions from a CSV” (or “Match its columns yourself” in the import window). Pick what each column holds, choose how dates are written if the file could be read either way, and check the preview: every row is marked new, already in KevFin, or needing a look. If the file has no header row, tick “Row 1 is a transaction”. Nothing is saved until you press Import, and KevFin remembers your choices for the next file with the same column names.',
        },
        {
          q: 'Can I get my data out as a spreadsheet?',
          a: 'Yes. Setup → “Download as a spreadsheet” saves your transactions (optionally for a date range), holdings, or daily net worth history as CSV files that open in Excel, Numbers or Google Sheets. The files are made on this computer and go straight to your downloads. Each transaction row carries a KevFin ID, so importing that file again doesn’t add any transaction twice.',
        },
      ],
    },
    forecast: {
      title: 'Forecast: how it works',
      intro: 'What the Monte Carlo projection does and doesn’t model.',
      items: [
        {
          q: 'How is the projection computed?',
          a: `It runs a ${MONTE_CARLO_RUNS}-path Monte Carlo. Investment returns are sampled each year from your expected return ± volatility (a normal draw); income, spending, and real-estate growth are deterministic. The shaded band is the 10–90% range of outcomes and the line is the median.`,
        },
        {
          q: 'Are the dollar figures in today’s or future money?',
          a: 'Your choice: the Today’s $ / Future $ switch above the chart. Today’s $ (the default) shows every amount in today’s purchasing power; Future $ shows the actual dollars of each future year. You enter spending in today’s dollars and it grows with inflation; income grows by each earner’s annual raise.',
        },
        {
          q: 'Where do the default income & spending come from?',
          a: 'They’re seeded once from a trailing average of your real transaction data (more stable than a single month). Under You, “Use my averages” re-applies them, and Spending breakdown can set inflation to your observed spending trend.',
        },
        {
          q: 'How are kids modeled?',
          a: 'The cost of kids you have today is already baked into your spending, so the model drops spending by the per-kid cost as each child reaches the independence age (the empty-nest effect) rather than adding it on top.',
        },
        {
          q: 'How are account tax types determined?',
          a: (
            <>
              The Forecast model needs tax buckets ({meta ? meta.taxBuckets.map(b => BUCKET_LABELS[b] ?? b).join(' / ') : 'taxable / pre-tax / Roth / HSA / 529'}), but connections only report a coarse type. We infer the bucket best-effort from the account name (e.g. "Roth IRA", "401(k)", "HSA"). It’s a heuristic — reassign any account that’s mislabeled.
            </>
          ),
        },
        {
          q: 'What does "success probability" mean?',
          a: `It’s the share of the ${MONTE_CARLO_RUNS} simulated futures in which your investable assets never hit $0 before your “Plan to age”. Real-estate equity isn’t counted unless you mark a property “Sell” under Home. With “Use past markets for the whole forecast” on, it is instead the share of past starting years (from 1928) whose replay never ran out; with a spending rule other than Steady, spending is cut instead of running out, so check the cuts shown beside the figure.`,
        },
        {
          q: 'How are taxes worked out?',
          a: 'By default with the two flat rates under Advanced → Taxes. Switch on “Work out tax from the IRS brackets” to calculate each year’s federal income tax from the published tables (2026 and 2027; later years grow with your inflation setting): wages after pre-tax savings, the taxable part of Social Security, pre-tax withdrawals and required distributions, Roth conversions, and gains on taxable-account withdrawals (half of each withdrawn dollar is assumed to be gain). Payroll tax, one flat state rate and Medicare income surcharges are included, and withdrawals are increased so spending is still covered after tax. These are estimates for planning, not tax advice.',
        },
        {
          q: 'What does the Roth conversion view show?',
          a: 'With tax brackets on, you can model moving pre-tax savings to Roth each year between two ages, up to the top of a chosen bracket and optionally stopping before the next Medicare surcharge tier (income from age 63 counts, because premiums look back two years). The tax is paid from your taxable account, so a year converts less when that account can’t cover it. The Tax picture card compares the plan with and without conversions; it shows amounts only and never moves money.',
        },
        {
          q: 'What does the tax model leave out?',
          a: 'State tax brackets (one flat state rate stands in), the alternative minimum tax, tax credits, itemised deductions, health-insurance (ACA) subsidies and estate tax. Interest and dividends earned inside the taxable account aren’t taxed year by year, and the filing status is single or married filing jointly only.',
        },
        {
          q: 'What does “How would this plan have done?” show?',
          a: 'It replays your plan through past US markets: one run for each starting year since 1928 that has enough history to cover your whole plan, using that year’s and the following years’ actual stock returns (S&P 500 with dividends), 10-year Treasury bond returns and inflation. It counts how many starting years lasted, names the toughest one, and shows the money left at the end in today’s dollars. Past stretches overlap, so treat it as a stress test, not a probability. If fewer than 20 starting years fit, it says so instead of reusing the data. Estimates for planning, not advice.',
        },
        {
          q: 'What do the retirement spending rules do?',
          a: '“Steady” spends the same amount every year, raised with inflation. “Guardrails” (the Guyton–Klinger rules) by default spends 10% less when the share of savings you spend climbs 20% above where it started, and 10% more when it drops 20% below. “Share of savings” spends a set percent of your savings each year, optionally kept between a floor and a ceiling. Only everyday spending changes, and only once everyone has retired; mortgage and home costs, kids, college and life events stay as planned.',
        },
        {
          q: 'How are the amounts in “What your plan supports” worked out?',
          a: 'By re-running the forecast many times with one setting changed (spending, your investable balance or the retirement age) on the same set of simulated markets, and searching for the point where the chance of lasting crosses your chosen confidence (85% unless you change it). Safe yearly spending is rounded to $500; balances to $1,000. “Enough to stop working now” assumes everyone stops today; “Enough to stop saving” keeps everyone working to the planned age but adds nothing more to savings. The guardrails show the balances at which your safe spending would change, as if your savings were that amount today. These use 1,000 simulated futures, so they can differ slightly from the headline chance; when the forecast replays past markets they use the same past starting years as the headline instead. Estimates for planning, not advice.',
        },
        {
          q: 'How does “Plan versus actual” work?',
          a: 'Pin the forecast with 📌 and it is saved as your plan, with its date and its likely range for each year ahead. From then on your recorded net worth is drawn against that plan, and the tile says how far ahead of or behind the plan’s middle line you are today. Amounts are the dollars of each day, not adjusted for inflation, and anything the forecast leaves out is left out of the recorded figure too. Pins made before this feature need re-pinning to be tracked.',
        },
        {
          q: 'What is saved in a scenario?',
          a: 'Everything that describes the plan on this page: assumptions, earners, life events, kids, account contributions, the what-if levers and the tax, market and spending-rule settings. Your accounts, balances, and choices about which accounts are left out are not saved, so loading or comparing a scenario always uses today’s balances. Scenarios are stored with your other settings on this server and are not shared with the AI assistant. The comparison is worked out only when you press Compare.',
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
        title="How this page works"
        aria-label="How this page works"
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
