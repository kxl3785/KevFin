// The Forecast's "Your plan" panel shows one topic at a time, as five tabs.
// Before the tabs it was a stack of eight folding sections (You, Partner, Social
// Security, Spending, Savings, Home, Family, Assumptions); their ids live on in
// milestone pins and in the saved "which sections were open" state, so this file
// maps them onto the tabs. Pure, so it can be tested.

export const PLAN_TABS = ['people', 'spending', 'savings', 'home', 'rates'] as const;
export type PlanTab = typeof PLAN_TABS[number];

// The tab's label is an emoji and a short word. `more` finishes the label where
// it fits ("Home & family"), and is dropped on narrow screens (index.css).
export const PLAN_TAB_META: Record<PlanTab, { icon: string; label: string; more?: string }> = {
  people: { icon: '👤', label: 'People' },
  spending: { icon: '🛒', label: 'Spending' },
  savings: { icon: '💰', label: 'Savings' },
  home: { icon: '🏠', label: 'Home', more: ' & family' },
  rates: { icon: '📈', label: 'Rates' },
};

// The old section ids, in their old page order, and the tab each now lives in.
// `homeRates` is the home growth rates, which moved from Home to Rates.
const LEGACY_ORDER = ['you', 'partner', 'ss', 'spending', 'savings', 'home', 'family', 'advanced'] as const;
const SECTION_TAB: Record<string, PlanTab> = {
  you: 'people', partner: 'people', ss: 'people',
  spending: 'spending', savings: 'savings',
  home: 'home', family: 'home',
  advanced: 'rates', homeRates: 'rates',
};

const isTab = (s: unknown): s is PlanTab => typeof s === 'string' && (PLAN_TABS as readonly string[]).includes(s);

// The tab that holds an old section (or a tab named directly); null if unknown.
export function tabForSection(section: string): PlanTab | null {
  if (isTab(section)) return section;
  return Object.prototype.hasOwnProperty.call(SECTION_TAB, section) ? SECTION_TAB[section] : null;
}

// Where the page scrolls to for a section: the panel's top (so the tabs stay in
// view) unless the section sits partway down a long tab. Ids match Forecast.tsx.
export function sectionAnchor(section: string): string {
  if (section === 'ss') return 'fc-group-ss';
  if (section === 'family') return 'fc-group-family';
  if (section === 'homeRates') return 'fc-group-home-rates';
  return 'fc-inputs';
}

// The tab to show. `saved` is the stored tab (`mon.fcPlanTab`); until one is
// stored, the first section that was open in the old folding layout
// (`mon.fcGroups`, e.g. {"you":true}) picks it, so the panel opens where the user
// last worked. Anything malformed falls back to People.
export function resolvePlanTab(saved: unknown, legacyGroups: unknown): PlanTab {
  if (isTab(saved)) return saved;
  if (typeof saved === 'string' && saved) {
    const t = tabForSection(saved);
    if (t) return t;
  }
  if (legacyGroups && typeof legacyGroups === 'object' && !Array.isArray(legacyGroups)) {
    const g = legacyGroups as Record<string, unknown>;
    for (const k of LEGACY_ORDER) if (g[k] === true) return SECTION_TAB[k];
  }
  return 'people';
}

// Arrow-key movement along the tab list (wrapping), Home and End. Null for any
// other key.
export function tabAfterKey(current: PlanTab, key: string): PlanTab | null {
  const i = PLAN_TABS.indexOf(current), n = PLAN_TABS.length;
  if (key === 'ArrowRight') return PLAN_TABS[(i + 1) % n];
  if (key === 'ArrowLeft') return PLAN_TABS[(i - 1 + n) % n];
  if (key === 'Home') return PLAN_TABS[0];
  if (key === 'End') return PLAN_TABS[n - 1];
  return null;
}
