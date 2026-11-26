// Wording for a home's yearly appreciation on the Dashboard. The rate itself is
// worked out by the server (GET /api/properties/growth) from the home's value
// history; a home with no usable history falls back to the Forecast's flat
// "Home value growth" assumption.

export interface HomeGrowth {
  /** Compound annual growth as a fraction (0.05 = 5% a year). Can be negative. */
  rate: number;
  /** Years the rate was measured over (5, or less when the history is shorter). */
  years: number;
  from: string; // YYYY-MM-DD
  to: string;
  /** 'history' = value points entered for this home; 'zip' = Zillow's index for its ZIP code. */
  source: 'history' | 'zip';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''} ${iso.slice(0, 4)}`.trim();
const trim0 = (n: number) => n.toFixed(1).replace(/\.0$/, '');

/** "4%", "6.2%", "−1.3%": one decimal at most, with a real minus sign. */
export function growthPctText(rate: number): string {
  const t = trim0(Math.abs(rate) * 100);
  return `${rate < 0 && t !== '0' ? '−' : ''}${t}%`;
}

/** "5-yr", "3.5-yr": the length of the period the rate covers. */
function spanText(years: number): string {
  return `${trim0(years)}-yr`;
}

/** The short note beside the Appreciation amount. */
export function growthNote(g: HomeGrowth | undefined, fallbackRate: number): string {
  return g
    ? `${spanText(g.years)} avg, ${growthPctText(g.rate)}/yr`
    : `est. at ${growthPctText(fallbackRate)}/yr`;
}

/** The full explanation (hover text): what the rate is and where it came from. */
export function growthExplanation(g: HomeGrowth | undefined, fallbackRate: number): string {
  const paper = 'A paper gain, not cash, until you sell';
  if (!g) {
    return `Estimated growth in the home's value: ${growthPctText(fallbackRate)} a year, the Forecast's "Home value growth" setting (Forecast → Home), used because this home has under a year of value history. ${paper}`;
  }
  const where = g.source === 'history'
    ? 'from the value history entered for this home'
    : "from Zillow's home value index for its ZIP code (the neighbourhood, not this exact house)";
  return `Estimated growth in the home's value: ${growthPctText(g.rate)} a year, its average over the last ${trim0(g.years)} years (${monthYear(g.from)} to ${monthYear(g.to)}), ${where}. The past may not repeat. ${paper}. The Forecast uses its own "Home value growth" setting`;
}
