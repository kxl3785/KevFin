// The word on the Forecast's first headline tile, beside the chance the money
// lasts. It describes likelihood only: "on track" belongs to plan tracking (the
// "Today against your plan" tile), so the page uses that phrase for one thing.
// The bands are the tile colour's (green / amber / red).
export const SUCCESS_BANDS = [
  { min: 90, word: 'Likely' },
  { min: 70, word: 'Uncertain' },
  { min: -Infinity, word: 'At risk' },
] as const;

export function successStatus(pct: number): string {
  return (SUCCESS_BANDS.find(b => pct >= b.min) ?? SUCCESS_BANDS[SUCCESS_BANDS.length - 1]).word;
}
