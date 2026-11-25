// Reading and showing the user's description of what a holding tracks: one
// ticker ("VFFVX") or a mix from the plan's fact sheet ("VTI 60, BND 40").
// Used by the holding-profile editor; the server re-validates everything
// (server/src/services/holdingProfiles.ts), so the rules here must match it.
//
// Units: weight is always a FRACTION of the holding here (0.6 = 60%), and a
// mix's weights sum to exactly 1.

export interface MixPart { ticker: string; weight: number }

export const MAX_PARTS = 10;
const TICKER = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
const NUMBER = /^(\d+(\.\d*)?|\.\d+)$/;
// Fractions that sum to 1 within this, or percents to 100 within this × 100.
const SUM_SLACK = 0.005;

// 90 → "90", 33.3333 → "33.33".
const num = (x: number) => String(Number(x.toFixed(2)));

// Accepts, case-insensitively:
//   "VFFVX"                  one ticker = the whole holding
//   "vti 60, bnd 40"         ticker then percent
//   "VTI 60% / BND 40%"      any of , ; / + & | · : as separators
//   "VTI:60 BND:40"
//   "60% VTI, 40% BND"       percent first
//   "VTI 0.6, BND 0.4"       fractions, when all are ≤ 1 and add up to 1
// Anything else gets a plain-English error.
export function parseMixInput(text: string): { mix: MixPart[] } | { error: string } {
  const tokens = text
    .split(/[\s,;/+&|·:%]+|[—–]+/)
    .map(t => t.trim())
    .filter(t => t && !/^[-=]+$/.test(t));
  if (!tokens.length) return { error: 'Enter a ticker, like VFFVX, or a mix, like VTI 60, BND 40.' };

  // Pair each ticker with its number. The first token decides the order:
  // "VTI 60 BND 40" (ticker first) or "60 VTI 40 BND" (number first).
  const numberFirst = NUMBER.test(tokens[0]);
  const pairs: { ticker: string; amount: number | null }[] = [];
  let pendingAmount: number | null = null;
  for (const t of tokens) {
    if (NUMBER.test(t)) {
      const n = Number(t);
      if (numberFirst) {
        if (pendingAmount != null) return { error: `“${t}” needs a ticker before it.` };
        pendingAmount = n;
      } else {
        const last = pairs[pairs.length - 1];
        if (!last || last.amount != null) return { error: `“${t}” needs a ticker before it.` };
        last.amount = n;
      }
    } else {
      const ticker = t.toUpperCase();
      if (!TICKER.test(ticker)) return { error: `“${t}” doesn’t look like a ticker symbol.` };
      if (numberFirst) {
        if (pendingAmount == null) return { error: `Give ${ticker} a percentage too.` };
        pairs.push({ ticker, amount: pendingAmount });
        pendingAmount = null;
      } else {
        pairs.push({ ticker, amount: null });
      }
    }
  }
  if (pendingAmount != null) return { error: `“${num(pendingAmount)}” needs a ticker after it.` };

  if (pairs.length > MAX_PARTS) return { error: `List at most ${MAX_PARTS} funds.` };
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.ticker)) return { error: `${p.ticker} is listed twice.` };
    seen.add(p.ticker);
  }

  // One ticker: the whole holding. A lone "100" (or "1") is fine; anything else
  // is almost certainly a half-typed mix.
  if (pairs.length === 1) {
    const a = pairs[0].amount;
    if (a != null && Math.abs(a - 100) > 100 * SUM_SLACK && Math.abs(a - 1) > SUM_SLACK) {
      return { error: `A single fund is the whole holding (100%), not ${num(a)}%. To describe a mix, list each fund with its share.` };
    }
    return { mix: [{ ticker: pairs[0].ticker, weight: 1 }] };
  }

  const missing = pairs.find(p => p.amount == null);
  if (missing) return { error: `Give ${missing.ticker} a percentage too, like VTI 60, BND 40.` };
  const amounts = pairs.map(p => p.amount as number);
  const zero = pairs.find(p => (p.amount as number) <= 0);
  if (zero) return { error: `${zero.ticker}’s share must be more than 0.` };

  const sum = amounts.reduce((s, a) => s + a, 0);
  const allFractions = amounts.every(a => a <= 1);
  const fractions = allFractions && Math.abs(sum - 1) <= SUM_SLACK;
  if (!fractions && Math.abs(sum - 100) > 100 * SUM_SLACK) {
    return { error: allFractions
      ? `Fractions add up to ${num(sum)}, not 1.`
      : `Percentages add up to ${num(sum)}%, not 100%.` };
  }
  return { mix: pairs.map((p, i) => ({ ticker: p.ticker, weight: amounts[i] / sum })) };
}

// 0.6 → "60%", 1/3 → "33.3%".
function pct(weight: number): string {
  return `${Number((weight * 100).toFixed(1))}%`;
}

// "VTI 60% · BND 40%", or just "VFFVX" for a one-fund description.
export function formatMix(mix: MixPart[]): string {
  if (mix.length === 1) return mix[0].ticker;
  return mix.map(p => `${p.ticker} ${pct(p.weight)}`).join(' · ');
}

// The text to prefill the editor with, in a form parseMixInput reads back:
// "VTI 60, BND 40", or "VFFVX".
export function mixToInput(mix: MixPart[]): string {
  if (mix.length === 1) return mix[0].ticker;
  return mix.map(p => `${p.ticker} ${Number((p.weight * 100).toFixed(2))}`).join(', ');
}
