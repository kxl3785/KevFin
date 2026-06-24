// Risk-tolerance profiling + model portfolios.
//
// The questionnaire mirrors what financial advisors actually ask (time horizon,
// goal, loss reaction, experience, risk/return preference, financial capacity,
// age). Each answer carries points; the total maps to one of five standard
// risk profiles, each with a model target allocation over the same broad asset
// classes the allocation look-through produces server-side.

// Asset-class keys MUST match the buckets emitted by the allocation service
// (server/src/services/allocation.ts → byAssetClass) so current vs. model pair up.
export type AssetClassKey =
  | 'Domestic Stock' | 'Foreign Stock' | 'Bonds' | 'Short Term' | 'Commodities' | 'Crypto';

// Canonical display labels + colors for the comparison chart. Order here is the
// order rows render in.
export const ASSET_CLASS_META: { key: AssetClassKey; label: string; color: string }[] = [
  { key: 'Domestic Stock', label: 'U.S. Stocks', color: '#6c8fff' },
  { key: 'Foreign Stock', label: 'Intl. Stocks', color: '#4ade80' },
  { key: 'Bonds', label: 'Bonds', color: '#f472b6' },
  { key: 'Short Term', label: 'Cash & Short-Term', color: '#38bdf8' },
  { key: 'Commodities', label: 'Commodities', color: '#fbbf24' },
  { key: 'Crypto', label: 'Crypto', color: '#a78bfa' },
];

export type ProfileId = 'conservative' | 'moderately-conservative' | 'moderate' | 'growth' | 'aggressive';

export interface RiskProfile {
  id: ProfileId;
  name: string;
  blurb: string;
  // Model target weights (percent, summing to 100) by asset class.
  model: Record<AssetClassKey, number>;
}

export const RISK_PROFILES: Record<ProfileId, RiskProfile> = {
  conservative: {
    id: 'conservative',
    name: 'Conservative',
    blurb: 'Capital preservation first. Heavy bonds and cash to keep year-to-year swings small.',
    model: { 'Domestic Stock': 18, 'Foreign Stock': 12, 'Bonds': 50, 'Short Term': 18, 'Commodities': 2, 'Crypto': 0 },
  },
  'moderately-conservative': {
    id: 'moderately-conservative',
    name: 'Moderately Conservative',
    blurb: 'Income with a little growth. Still bond-tilted, but more equity than a pure preservation mix.',
    model: { 'Domestic Stock': 28, 'Foreign Stock': 17, 'Bonds': 42, 'Short Term': 10, 'Commodities': 3, 'Crypto': 0 },
  },
  moderate: {
    id: 'moderate',
    name: 'Moderate',
    blurb: 'A balanced 60/40-style mix — growth and stability roughly in step.',
    model: { 'Domestic Stock': 38, 'Foreign Stock': 22, 'Bonds': 30, 'Short Term': 6, 'Commodities': 4, 'Crypto': 0 },
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    blurb: 'Long-term growth focus. Mostly equities, with a bond sleeve to soften drawdowns.',
    model: { 'Domestic Stock': 48, 'Foreign Stock': 27, 'Bonds': 18, 'Short Term': 3, 'Commodities': 3, 'Crypto': 1 },
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive',
    blurb: 'Maximum long-term growth. Almost fully invested in equities; built to ride out big swings.',
    model: { 'Domestic Stock': 57, 'Foreign Stock': 30, 'Bonds': 8, 'Short Term': 2, 'Commodities': 1, 'Crypto': 2 },
  },
};

export interface QuestionOption { label: string; points: number }
export interface Question { id: string; prompt: string; help?: string; options: QuestionOption[] }

// Seven scored questions (1–4 points each → total 7–28).
export const QUESTIONS: Question[] = [
  {
    id: 'horizon',
    prompt: 'When do you expect to start drawing on this money?',
    help: 'Your time horizon is the single biggest driver of how much risk you can take.',
    options: [
      { label: 'Within 3 years', points: 1 },
      { label: '3 – 7 years', points: 2 },
      { label: '8 – 15 years', points: 3 },
      { label: 'More than 15 years', points: 4 },
    ],
  },
  {
    id: 'goal',
    prompt: 'What is your primary goal for this portfolio?',
    options: [
      { label: 'Preserve capital — avoid losses', points: 1 },
      { label: 'Generate income with some growth', points: 2 },
      { label: 'Balanced growth and stability', points: 3 },
      { label: 'Maximize long-term growth', points: 4 },
    ],
  },
  {
    id: 'reaction',
    prompt: 'Your portfolio drops 20% in a year. What do you do?',
    help: 'There are no wrong answers — this gauges how you behave under stress.',
    options: [
      { label: 'Sell everything to stop further losses', points: 1 },
      { label: 'Sell some and move to safer assets', points: 2 },
      { label: 'Hold and wait for recovery', points: 3 },
      { label: 'Buy more while prices are low', points: 4 },
    ],
  },
  {
    id: 'experience',
    prompt: 'How would you describe your investing experience?',
    options: [
      { label: 'None — this is new to me', points: 1 },
      { label: 'Limited — mostly cash and CDs', points: 2 },
      { label: 'Good — I own stocks and funds', points: 3 },
      { label: 'Extensive — I actively manage a diversified portfolio', points: 4 },
    ],
  },
  {
    id: 'tradeoff',
    prompt: 'Which one-year range of outcomes feels most comfortable?',
    help: 'Higher potential gains come with deeper potential losses.',
    options: [
      { label: 'Gain 6% / Lose 3%', points: 1 },
      { label: 'Gain 12% / Lose 8%', points: 2 },
      { label: 'Gain 20% / Lose 15%', points: 3 },
      { label: 'Gain 30% / Lose 25%', points: 4 },
    ],
  },
  {
    id: 'capacity',
    prompt: 'How stable is your income and emergency cushion?',
    options: [
      { label: 'Unstable income, no emergency fund', points: 1 },
      { label: 'Somewhat stable, small cushion', points: 2 },
      { label: 'Stable income, a few months saved', points: 3 },
      { label: 'Very stable, ample emergency fund', points: 4 },
    ],
  },
  {
    id: 'age',
    prompt: 'What is your age range?',
    help: 'A proxy for how long your money can stay invested.',
    options: [
      { label: '65 or older', points: 1 },
      { label: '50 – 64', points: 2 },
      { label: '35 – 49', points: 3 },
      { label: 'Under 35', points: 4 },
    ],
  },
];

export const MIN_SCORE = QUESTIONS.length; // 7
export const MAX_SCORE = QUESTIONS.length * 4; // 28

// Map a total score to a risk profile.
export function scoreToProfile(score: number): RiskProfile {
  if (score <= 11) return RISK_PROFILES.conservative;
  if (score <= 16) return RISK_PROFILES['moderately-conservative'];
  if (score <= 21) return RISK_PROFILES.moderate;
  if (score <= 25) return RISK_PROFILES.growth;
  return RISK_PROFILES.aggressive;
}
