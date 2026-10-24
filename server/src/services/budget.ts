import { getDb } from '../db/schema.js';
import { getAllTransactions, type RawTxn } from './simplefin.js';
import { syncFeedTransactions, readFeedTransactions, FEED_WINDOW_DAYS } from './feedStore.js';
import { getAllPlaidTransactions } from './plaid.js';
import { realEstateCarry, type RealEstateCarry } from './mortgage.js';
import {
  TAXONOMY, CATEGORIES, suggestEmoji, normalizeImportedCategory, ensureImportedCategories,
  type Category, type CatDef, type CatGroup,
} from './taxonomy.js';
import {
  getCategoryLabeler, getActiveCategories, getCategoryGroupMap,
  defaultGroupOf, groupColorOf, GROUP_COLOR, TAX_EMOJI,
} from './categories.js';

// Combined bank/card transaction feed for budgeting. SimpleFIN and Plaid expose
// the identical RawTxn shape (Plaid normalized to SimpleFIN's "+ = money in"
// sign), so the budget treats both feeds uniformly.
//
// Reading the feed goes through the durable transactions table: the provider
// calls here trigger their ~daily lazy cache refresh (so page views keep data
// fresh, as before), the current payloads are synced into the table, and the
// table is what gets served — including rows older than the providers' 2-year
// window, which used to silently age out of the budget.
async function getFeedTransactions(): Promise<RawTxn[]> {
  const [sf, plaid] = await Promise.all([getAllTransactions(), getAllPlaidTransactions()]);
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - FEED_WINDOW_DAYS * 86400;
  syncFeedTransactions(db, 'simplefin', sf, since);
  syncFeedTransactions(db, 'plaid', plaid, since);
  return readFeedTransactions(db);
}

// The taxonomy constants and pure category helpers live in taxonomy.ts
// (dependency-free, so the versioned migration runner can use them without an
// import cycle). Re-exported here so consumers keep importing from budget.
export { TAXONOMY, CATEGORIES, suggestEmoji, normalizeImportedCategory } from './taxonomy.js';
export type { Category, CatDef, CatGroup } from './taxonomy.js';

// Category management (labeler, groups, active list, snapshot/undo/reset)
// lives in categories.ts; re-exported so routes keep importing from budget.
export * from './categories.js';
const INCOME_SET = new Set(TAXONOMY.find(g => g.name === 'Income')!.categories.map(c => c.name));
// Internal money movement — excluded from spending AND income everywhere. Credit
// Card Payment is its own visible type but, like Transfers, never counts toward
// the budget (paying a card is moving money, not new spending).
const EXCLUDED_CATEGORIES = new Set(['Transfers', 'Credit Card Payment']);
const isExcluded = (c: string) => EXCLUDED_CATEGORIES.has(c);

// Cash-flow spending counts purchases, not the cash that moves to fund them, so
// account-to-account Transfers never count. A Credit Card Payment is the same kind
// of internal move — BUT only when the card it pays is actually tracked: then we
// count the card's own purchases instead. If the card isn't connected, the payment
// out of the bank account is the ONLY record of that spending, so excluding it would
// silently drop a whole card's worth of expenses and overstate the savings rate.
// `creditCardTracked` is the result of creditCardIsTracked() for the period.
export function isInternalTransfer(category: string, creditCardTracked: boolean): boolean {
  if (category === 'Transfers') return true;
  if (category === 'Credit Card Payment') return creditCardTracked;
  return false;
}
// Keyword rules mapping "payee + description" to a subcategory (first match wins).
const RULES: { re: RegExp; cat: Category }[] = [
  // Food & Dining
  { re: /grocery|whole foods|trader joe|safeway|kroger|costco|wal-?mart|aldi|publix|wegmans|h-?e-?b|sprouts|mitsuwa|good fortune|supermarket|food market/i, cat: 'Groceries' },
  { re: /coffee|starbucks|dunkin|peet|philz|\btea\b|boba|\bcafe\b/i, cat: 'Coffee Shops' },
  { re: /doordash|uber eats|grubhub|restaurant|mcdonald|chipotle|pizza|grill|kitchen|\bbar\b|taco|sushi|ramen|panera|chick-?fil|wendy|burger|\bdd \*|eatery|bistro|diner|\bbbq\b/i, cat: 'Restaurants & Bars' },
  // Auto & Transport
  { re: /shell|chevron|exxon|mobil|\bgas\b|fuel|quiktrip|\bqt\b|\bbp\b|\b76\b|arco|marathon|circle k|wawa|sheetz|valero|conoco/i, cat: 'Gas' },
  { re: /uber|lyft|\btaxi\b|ride ?share|metro|transit|amtrak|caltrain/i, cat: 'Taxi & Ride Shares' },
  { re: /parking|\btoll\b|garage/i, cat: 'Parking & Tolls' },
  { re: /auto ?pay|car payment|gm financial|toyota financial|honda financial|ford credit|carvana|auto loan|capital one auto/i, cat: 'Auto Payment' },
  // Housing
  { re: /home depot|lowe'?s|ace hardware|menards|hardware|\bpaint\b/i, cat: 'Home Improvement' },
  { re: /terminix|orkin|\bmaids?\b|merry maid|molly maid|housekeep|cleaning|\blawn\b|landscap|\bpest\b|exterminat|plumb|\bhvac\b|\ba\/?c repair\b|roofing|\bgutter|handyman|\bpool\b|\bspa service|septic|chimney|pressure ?wash|junk removal|\bjanitor/i, cat: 'Home Services' },
  { re: /\brent\b|apartment|leasing|property mgmt/i, cat: 'Rent' },
  // Health & Wellness
  { re: /pharmacy|\bcvs\b|walgreens|doctor|dental|dentist|medical|clinic|hospital|\bhealth\b|optical|vision|radiology|mychart/i, cat: 'Medical' },
  { re: /\bgym\b|fitness|equinox|peloton|yoga|pilates|crossfit|lifetime/i, cat: 'Fitness' },
  // Shopping
  { re: /best buy|newegg|micro center|apple\.com|apple store|b&h photo|electronics/i, cat: 'Electronics' },
  { re: /nordstrom|macy|\bnike\b|\bgap\b|h&m|zara|uniqlo|clothing|apparel|lululemon|old navy/i, cat: 'Clothing' },
  { re: /amazon|amzn|target|ebay|etsy|\bshop\b|walmart\.com|wayfair|\bikea\b/i, cat: 'Shopping' },
  // Children
  { re: /child ?care|daycare|day care|preschool|nanny|babysit|kindercare|montessori/i, cat: 'Child Care' },
  { re: /\bkids?\b|youth|scouts|children/i, cat: 'Child Activities' },
  // Travel & Lifestyle
  { re: /airlines?|hotel|airbnb|expedia|booking\.com|marriott|hilton|\bdelta\b|united air|southwest|american airlines|car rental|hertz|enterprise rent|vacation|resort|vrbo/i, cat: 'Travel & Vacation' },
  { re: /cinema|movie|theater|amc |steam|playstation|xbox|nintendo|ticketmaster|concert|museum|\bgolf\b|recreation|spotify|netflix|hulu|disney\+?|hbo|entertainment/i, cat: 'Entertainment & Recreation' },
  { re: /salon|\bspa\b|barber|sport clips|\bhair\b|\bnail\b|beauty|cosmetic/i, cat: 'Personal' },
  // Bills & Utilities
  { re: /electric|\bpg&e\b|atmos|octopus|\bpower\b|\benergy\b|\butility\b|\btxu\b|gexa|oncor|centerpoint|con ?ed|national grid|eversource|xcel|evergy|\bnrg\b|\bcps energy/i, cat: 'Gas & Electric' },
  // Matches "<City> Water", "Water Utilities/Dept", "Water & Sewer", etc. Runs
  // after the food/shopping rules, so "Water Grill" is already claimed as a
  // restaurant before a bare \bwater\b could mis-flag it as a utility.
  { re: /\bwater\b|\bsewer\b|\bwssc\b|epcor|aqua america/i, cat: 'Water' },
  { re: /comcast|xfinity|at&t|verizon|t-mobile|internet|spectrum|\bfios\b|\bphone\b|wireless|google fiber/i, cat: 'Internet & Phone' },
  { re: /youtube ?(tv|premium)|prime video|patreon|icloud|google (storage|one)|paramount|adobe|membership|subscription|anthropic|openai|chatgpt|notion|dropbox/i, cat: 'Subscriptions' },
  // Financial
  { re: /\btax\b|\birs\b|franchise tax|treasury|h&r block|turbotax/i, cat: 'Taxes' },
  { re: /insurance|geico|state farm|allstate|progressive|\bpolicy\b|\bvault\b|metlife/i, cat: 'Insurance' },
  { re: /\bfee\b|interest charge|finance charge|service charge|overdraft|wire fee/i, cat: 'Financial Fees' },
  // Gifts & Donations
  { re: /charity|donation|red cross|goodwill|nonprofit|\bchurch\b|tithe|gofundme/i, cat: 'Charity' },
  { re: /\bgifts?\b|florist|flowers/i, cat: 'Gifts' },
];

// Income-source rules for positive amounts (first match wins; else Other Income).
const PAYCHECK_RE = /payroll|direct dep|paycheck|salary|wages|\bpay\b/i;
const DIVIDEND_RE = /dividend|capital gain|\binterest\b|\bdiv\b|reinvest/i;


// Tables and one-shot data migrations are applied by the versioned migration
// runner (db/migrations.ts) when the database is first opened, so there is
// nothing to create lazily anymore. Kept as a call-site marker.
function ensureTables() { getDb(); }

// A predicate over a merchant key: true when its amount sign should be reversed.
// A sign-flip rule generalises like a category base rule — it matches every
// merchant sharing the same normalised base (so "Bilt Housing", a future
// "Bilt Housing #42", etc. all flip), falling back to an exact-merchant match for
// bases too short to be specific.
export function getSignFlipMatcher(): (merchant: string) => boolean {
  ensureTables();
  const db = getDb();
  const merchants = new Set((db.prepare(`SELECT merchant FROM rules WHERE kind = 'sign'`).all() as { merchant: string }[]).map(r => r.merchant));
  const bases = new Set((db.prepare(`SELECT base FROM rules WHERE kind = 'sign_base'`).all() as { base: string }[]).map(r => r.base));
  return (merchant: string) => {
    if (merchants.has(merchant)) return true;
    if (!bases.size) return false;
    const b = merchantBase(merchant);
    return usableBase(b) && bases.has(b);
  };
}

// Set, clear, or (when `flip` omitted) toggle the sign-reversal rule for a
// merchant. Enabling stores a generalised base rule when the merchant's base is
// specific enough (else an exact-merchant rule); disabling clears both so a
// previously-flipped merchant always un-flips. Returns the resulting state.
export function setSignFlip(merchant: string, flip?: boolean): boolean {
  ensureTables();
  const db = getDb();
  const base = merchantBase(merchant);
  const useBase = usableBase(base);
  const next = flip === undefined ? !getSignFlipMatcher()(merchant) : flip;
  if (next) {
    if (useBase) db.prepare(`INSERT OR IGNORE INTO rules (kind, base) VALUES ('sign_base', ?)`).run(base);
    else db.prepare(`INSERT OR IGNORE INTO rules (kind, merchant) VALUES ('sign', ?)`).run(merchant);
  } else {
    db.prepare(`DELETE FROM rules WHERE kind = 'sign' AND merchant = ?`).run(merchant);
    if (useBase) db.prepare(`DELETE FROM rules WHERE kind = 'sign_base' AND base = ?`).run(base);
  }
  return next;
}

// How many existing transactions a sign-flip for this merchant covers (its
// generalised base, or the exact merchant when the base is too short) — so the UI
// can show the reach of the rule it just applied. Counts the same population the
// transactions list shows (internal Transfers / Credit Card Payments excluded), so
// the number matches the rows the user actually sees change.
export async function countSignFlip(merchant: string): Promise<number> {
  const base = merchantBase(merchant);
  const useBase = usableBase(base);
  const all = await getCategorizedTransactions();
  return all.filter(t => !isExcluded(t.category) && (useBase ? merchantBase(t.merchant) === base : t.merchant === merchant)).length;
}

export function setTarget(category: string, limit: number, period: 'monthly' | 'annual' = 'monthly') {
  ensureTables();
  const canon = getCategoryLabeler().canon(category);
  if (limit > 0) {
    getDb().prepare('INSERT OR REPLACE INTO budget_targets (category, monthly_limit, period) VALUES (?, ?, ?)')
      .run(canon, limit, period === 'annual' ? 'annual' : 'monthly');
  } else {
    getDb().prepare('DELETE FROM budget_targets WHERE category = ?').run(canon);
  }
}

function merchantKey(payee: string, description: string): string {
  return (payee || description || 'Unknown').trim().toLowerCase().slice(0, 40);
}

// Trailing 4 digits of an account name (e.g. "Chase Sapphire (4167)" → "4167"),
// a stable identifier shared between a SimpleFIN feed and a CSV export of the same
// account even when the names are worded differently. '' when none are present.
export const acctLast4 = (name: string): string => name.match(/(\d{4})\D*$/)?.[1] ?? '';

// One side of a duplicate-detection comparison: a (pre-flip) amount, the day it
// posted (ms since epoch), a normalised merchant key, and the account's last 4 digits.
export interface DupTxn { amount: number; day: number; merchant: string; acct: string }

// Whether an imported transaction duplicates an existing one. A bank feed and a CSV
// export of the same transaction routinely disagree on the posted date by a day or
// two and word the merchant differently, so we require only the same exact amount,
// a posted date within `windowMs`, and EITHER a matching merchant OR the same account
// — each is a strong enough secondary key to rule out a coincidental amount collision.
export function isDuplicateTxn(a: DupTxn, b: DupTxn, windowMs = 3 * 86400_000): boolean {
  return a.amount === b.amount
    && Math.abs(a.day - b.day) <= windowMs
    && ((a.merchant !== '' && a.merchant === b.merchant) || (a.acct !== '' && a.acct === b.acct));
}

// A normalised "base" for a merchant: strips store numbers, reference ids,
// punctuation and boilerplate words so variants of the same merchant collapse
// together (e.g. "SHELL OIL #1234" and "Shell Oil 56" → "shell oil"). Used to
// propagate a manual category to other transactions from a similar merchant.
const BASE_NOISE = /\b(the|a|an|llc|inc|co|corp|ltd|store|shop|pos|debit|credit|card|purchase|payment|us|usa|com|online|intl)\b/g;
export function merchantBase(merchant: string): string {
  return merchant
    .toLowerCase()
    .replace(/[*#].*$/, ' ')   // drop ref/id tail after * or #
    .replace(/\d+/g, ' ')      // drop digit runs (store numbers, dates)
    .replace(BASE_NOISE, ' ')
    .replace(/[^a-z ]+/g, ' ') // strip remaining non-letters
    .replace(/\s+/g, ' ')
    .trim();
}
// Only treat a base as specific enough to sweep similar merchants when it still
// carries real signal after normalisation (avoids over-matching on a stub).
function usableBase(base: string): boolean {
  return base.length >= 3;
}

// --- Rule matching ----------------------------------------------------------
// The single definition of which category rules apply to a transaction, shared by
// the categorizer and the Rules review so the two can never drift. Precedence:
// exact merchant rule → smart rules (most conditions first, ties by id) → base
// ("similar merchants") rule.
export type RuleSource = 'merchant' | 'smart' | 'base' | 'import' | 'auto';
export interface CategoryRuleRow {
  id: number; kind: 'merchant' | 'base' | 'smart';
  merchant: string | null; base: string | null; contains: string | null; amount: number | null;
  category: string;
}
export interface RuleInput { merchant: string; text: string; amount: number } // text = lower-cased "payee description"
export interface RuleIndex { merchant: Map<string, CategoryRuleRow>; base: Map<string, CategoryRuleRow>; smart: CategoryRuleRow[] }

export const ruleSpecificity = (r: Pick<CategoryRuleRow, 'base' | 'contains' | 'amount'>) =>
  (r.base != null ? 1 : 0) + (r.contains ? 1 : 0) + (r.amount != null ? 1 : 0);

export function loadRuleIndex(): RuleIndex {
  const rows = getDb().prepare(
    `SELECT id, kind, merchant, base, contains, amount, category FROM rules WHERE kind IN ('merchant','base','smart') ORDER BY id`
  ).all() as CategoryRuleRow[];
  const idx: RuleIndex = { merchant: new Map(), base: new Map(), smart: [] };
  for (const r of rows) {
    if (r.kind === 'merchant' && r.merchant != null) idx.merchant.set(r.merchant, r);
    else if (r.kind === 'base' && r.base != null) idx.base.set(r.base, r);
    else if (r.kind === 'smart') idx.smart.push(r);
  }
  idx.smart.sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a)); // stable: ties keep id order
  return idx;
}

// Every smart condition that is set must hold.
function smartRuleMatches(r: CategoryRuleRow, base: string, t: RuleInput): boolean {
  if (r.base != null && base !== r.base) return false;
  if (r.contains && !t.text.includes(r.contains)) return false;
  if (r.amount != null && Math.abs(t.amount).toFixed(2) !== Math.abs(r.amount).toFixed(2)) return false;
  return true;
}

// Rules that apply to a transaction, highest precedence first. The first one decides.
export function* matchingRules(idx: RuleIndex, t: RuleInput): Generator<CategoryRuleRow> {
  const m = idx.merchant.get(t.merchant);
  if (m) yield m;
  if (!idx.smart.length && !idx.base.size) return;
  const b = merchantBase(t.merchant);
  for (const r of idx.smart) if (smartRuleMatches(r, b, t)) yield r;
  const br = idx.base.get(b);
  if (br) yield br;
}

// --- Income-source clustering ----------------------------------------------
// Paychecks from one employer arrive under several payee strings — "Reformed
// Radiolo Payroll", "Reformed Radiology Direct Deposit", "Reformed Radiology" —
// differing only by payroll/deposit boilerplate and bank-truncated names. We
// collapse these into a single Sankey source. `incomeSourceBase` strips the
// payroll noise on top of merchantBase; `basesMerge` then clusters bases where
// the shorter is a prefix of the longer (allowing a few trailing chars to cover
// truncation like "radiolo" vs "radiology").
const INCOME_NOISE = /\b(payroll|direct|deposit|dir|dep|des|salary|wages?|pay|paychecks?|ach|ppd|edeposit|earnings?|income)\b/g;
// Aliases for the same employer that text similarity can't catch (acronym vs. full
// name, etc.): if a base matches the pattern, it collapses to the canonical base.
const INCOME_ALIASES: [RegExp, string][] = [
  [/\butswmc\b/, 'ut southwestern medical center'],
];
function incomeSourceBase(merchant: string): string {
  const full = merchantBase(merchant);
  const stripped = full.replace(INCOME_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const base = stripped.length >= 4 ? stripped : full;
  for (const [re, canon] of INCOME_ALIASES) if (re.test(base)) return canon;
  return base;
}
const titleCase = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase());
function basesMerge(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 5) return s === l;                       // too short to fuzzy-match
  return l.startsWith(s) && (l.length - s.length <= 3 || l[s.length] === ' ');
}

const SOURCE_TOP = 6; // income sources shown individually; the rest pool into "Other income"

interface IncomeSource { key: string; label: string; amount: number }
// Group income transactions into employer "sources" and return them ordered by
// amount, plus a merchant→sourceKey lookup so drill-down can reverse the merge.
function buildIncomeSources(incomeTx: { merchant: string; payee: string; amount: number }[]): { ordered: IncomeSource[]; keyOfMerchant: Map<string, string> } {
  const byMerchant = new Map<string, { amount: number; payee: string }>();
  for (const t of incomeTx) {
    const e = byMerchant.get(t.merchant) ?? { amount: 0, payee: t.payee || t.merchant };
    e.amount += t.amount; byMerchant.set(t.merchant, e);
  }
  const baseOf = new Map<string, string>();
  for (const m of byMerchant.keys()) baseOf.set(m, incomeSourceBase(m));

  // Cluster distinct bases, longest first so the fuller name anchors each cluster.
  const distinct = [...new Set(baseOf.values())].filter(Boolean).sort((a, b) => b.length - a.length);
  const reps: string[] = [];
  const repOfBase = new Map<string, string>();
  for (const base of distinct) {
    const rep = reps.find(r => basesMerge(r, base));
    if (rep) repOfBase.set(base, rep);
    else { reps.push(base); repOfBase.set(base, base); }
  }

  const sources = new Map<string, { key: string; amount: number; merchants: Set<string> }>();
  const keyOfMerchant = new Map<string, string>();
  for (const [m, v] of byMerchant) {
    const key = repOfBase.get(baseOf.get(m) ?? '') || baseOf.get(m) || m.toLowerCase();
    keyOfMerchant.set(m, key);
    const s = sources.get(key) ?? { key, amount: 0, merchants: new Set<string>() };
    s.amount += v.amount; s.merchants.add(m); sources.set(key, s);
  }

  const ordered: IncomeSource[] = [...sources.values()].map(s => {
    // Prefer the title-cased cluster base; fall back to the largest member's payee.
    let label = titleCase(s.key);
    if (!label) {
      let bestAmt = -1;
      for (const m of s.merchants) { const v = byMerchant.get(m)!; if (v.amount > bestAmt) { bestAmt = v.amount; label = v.payee; } }
    }
    return { key: s.key, label: label || 'Income', amount: s.amount };
  }).sort((a, b) => b.amount - a.amount);

  return { ordered, keyOfMerchant };
}

// Credit-card payments — paying down a card balance. Their own (excluded) type so
// they're distinguishable from generic account-to-account Transfers.
const CC_PAYMENT_RE = /payment thank you|card pmt|\bcard payment\b|bilt card|cardmember serv|autopay.*\b(card|visa|mastercard|amex)\b|\bepay(ment)?\b/i;

const TRANSFER_RE = /autopay|online payment|\btransfer\b|moneyline|brokerage services|fid bkg|robinhood money|money payment|^\s*to (brokerage|chase|personal|savings|checking|bilt|wells|bank)/i;

// Peer-to-peer payment apps. These are NOT auto-classified as Transfers — a Zelle
// "payment to Rosalio Gamez" is usually real spending (a contractor, childcare),
// not money moving between your own accounts. Genuine self-transfers via Zelle are
// still caught by detectTransferPairs (equal, opposite legs across accounts). The
// "Zelle Transfer to …" wording also contains "transfer", so P2P must short-circuit
// the TRANSFER_RE check above.
const P2P_RE = /\bzelle\b|\bvenmo\b|cash ?app/i;

const MORTGAGE_RE = /\bmortgage\b|home loan|\bheloc\b|property payment|home equity|loancare|mr\.?\s*cooper|pennymac|quicken loan|rocket mortgage|newrez|nationstar|shellpoint|phh mortgage|sps servicing|carrington mortgage/i;

// Liability accounts — credit cards, loans, mortgages, lines of credit. A
// POSITIVE amount here is a payment/credit (money coming IN to settle the
// balance), never real income, so it must not inflate income.
const LIABILITY_ACCT_RE = /mortgage|home ?loan|\bheloc\b|line of credit|\bloan\b|credit card|\bvisa\b|mastercard|\bamex\b|discover|sapphire|freedom|venture|palladium|signature|\bcard\b/i;
// Credit-card accounts specifically (subset of liabilities, excluding loans/HELOCs)
// — a positive amount here is a card payment, labeled Credit Card Payment.
const CC_ACCT_RE = /credit card|\bvisa\b|mastercard|\bamex\b|american express|discover|sapphire|freedom|venture|palladium|signature|\bcard\b/i;

export function autoCategory(payee: string, description: string, amount: number): Category {
  const text = `${payee} ${description}`;
  if (CC_PAYMENT_RE.test(text)) return 'Credit Card Payment';
  // P2P (Zelle/Venmo/Cash App) bypasses the transfer rule so it stays visible and
  // categorizable instead of being hidden as an internal move.
  if (!P2P_RE.test(text) && TRANSFER_RE.test(text)) return 'Transfers';
  if (MORTGAGE_RE.test(text)) return 'Mortgage';
  if (amount > 0) {
    if (PAYCHECK_RE.test(text)) return 'Paychecks';
    if (DIVIDEND_RE.test(text)) return 'Dividends & Capital Gains';
    return 'Other Income';
  }
  for (const r of RULES) if (r.re.test(text)) return r.cat;
  return 'Miscellaneous';
}

// Trailing bank reference id (e.g. "…Gamez JPM99chmnua1", "…ARAGON 29618049464").
const REF_TAIL_RE = /\s+(?:#|ref:?|conf:?|id:?)?\s*[A-Za-z]{0,4}\d[A-Za-z0-9]{4,}$/i;
// Payment aggregators whose generic payee ("PayPal", "SQ", "TST") hides the real
// merchant, which the bank tucks into the descriptor after a "*" — e.g.
// "PAYPAL *STEAM GAMES", "SQ *BLUE BOTTLE", "TST* CHIPOTLE". Amazon's "AMAZON
// MKTPL*…" is NOT here: its star is just a ref, and "Amazon" is already the merchant.
const AGGREGATOR_STAR_RE = /\b(paypal|pp|sq|sqc|square|tst|toast|stripe|ebay|gpay|google)\b\s*\*+\s*(.+)/i;
const aggregatorMerchant = (text: string): string | null => {
  const m = text.match(AGGREGATOR_STAR_RE);
  const name = m?.[2]?.trim();
  return name && name.length > 1 ? name : null;
};

// Pick the most informative display name for a transaction, surfacing the real
// counterparty that a generic payee would otherwise hide, and dropping noisy
// trailing reference ids. Applied to every transaction; the merchant key used for
// grouping/rules is left untouched.
export function displayPayee(payee: string, description: string): string {
  const p = (payee || '').trim(), d = (description || '').trim();
  // P2P (Zelle/Venmo/Cash App): "payment to/from NAME" — the name is the point.
  if (P2P_RE.test(`${p} ${d}`)) {
    const s = (/^(zelle|venmo|cash ?app)(\s+(transfer|payment))?$/i.test(p) && d) ? d : (p || d);
    return s.replace(REF_TAIL_RE, '').trim() || p || d || 'Unknown';
  }
  // Aggregators (PayPal/Square/Toast/Stripe/…): pull the merchant out of the descriptor.
  const agg = aggregatorMerchant(d) ?? aggregatorMerchant(p);
  if (agg) return agg.replace(REF_TAIL_RE, '').trim() || p || d || 'Unknown';
  // Otherwise keep the feed's payee (already a clean merchant name like "Amazon"),
  // falling back to the description, and trim any trailing reference id.
  return (p || d).replace(REF_TAIL_RE, '').trim() || p || d || 'Unknown';
}

export interface BudgetTxn {
  id: string; date: string; amount: number; description: string; payee: string;
  account: string; merchant: string; category: Category; suggested: Category;
  memo: string; postedAt: number; transactedAt: number | null;
  flipped?: boolean; // a sign-reversal rule is active for this merchant
  ruleId: number | null;   // the rules.id that decided the category (null for import / auto)
  ruleSource: RuleSource;  // what decided it: a rule, the import's own category, or the built-in guess
  amountEdited?: boolean; // the amount is a user override, not the feed/import value
}

// Auto-detect internal transfers / debt payments the keyword rules miss: an
// ambiguous (or keyword-flagged) expense matched by an equal, opposite credit in
// a *different* account within a few days is almost certainly money moving
// between accounts — not spending or income. Flags BOTH legs as Transfers so
// neither inflates spending nor income. User-categorized txns are left alone.
function detectTransferPairs(all: BudgetTxn[], ruledIds: Set<string>): number {
  const WINDOW_MS = 4 * 86400_000;
  const day = (d: string) => Date.parse(d + 'T00:00:00Z');
  const byMag = new Map<string, BudgetTxn[]>();
  for (const t of all) {
    const k = Math.abs(t.amount).toFixed(2);
    (byMag.get(k) ?? byMag.set(k, []).get(k)!).push(t);
  }
  const consumed = new Set<string>();
  // An expense leg: an outflow that's either already keyword-flagged Transfers or
  // simply uncategorized. A credit leg: an inflow that's a transfer or unlabeled.
  const isExpenseLeg = (t: BudgetTxn) => !ruledIds.has(t.id) && t.amount < 0 && (t.category === 'Transfers' || t.category === 'Miscellaneous');
  const isCreditLeg = (t: BudgetTxn) => !ruledIds.has(t.id) && t.amount > 0 && (t.category === 'Transfers' || t.category === 'Other Income');
  let flagged = 0;
  for (const t of all) {
    if (consumed.has(t.id) || !isExpenseLeg(t) || Math.abs(t.amount) < 1) continue;
    const cands = byMag.get(Math.abs(t.amount).toFixed(2)) ?? [];
    const td = day(t.date);
    const match = cands.find(o => o.id !== t.id && !consumed.has(o.id) && o.account !== t.account && isCreditLeg(o) && Math.abs(day(o.date) - td) <= WINDOW_MS);
    if (match) {
      if (t.category !== 'Transfers') flagged++;
      if (match.category !== 'Transfers') flagged++;
      t.category = 'Transfers';
      match.category = 'Transfers';
      consumed.add(t.id);
      consumed.add(match.id);
    }
  }
  return flagged;
}

export interface BudgetSummary {
  months: string[];                       // available YYYY-MM, newest first
  month: string;                          // the month being shown
  transactions: BudgetTxn[];              // for the requested month (excludes Transfers; Mortgage kept but flagged)
  byCategory: { category: string; spent: number; count: number; target: number; period?: 'monthly' | 'annual'; ytdSpent?: number; excluded?: boolean }[];
  needsReview: BudgetTxn[];               // uncategorized ('Other') expenses to assign
  recent: BudgetTxn[];                    // most-recent transactions across all months (for the overview)
  income: number;
  spending: number;
  mortgage: number;                       // mortgage payments (excluded from spending)
  housing: RealEstateCarry;               // property-derived carry breakdown (informational; not in spending)
  totalBudget: number;                    // sum of targets
  // For the in-progress month both figures are measured THROUGH the same day of the
  // month (`asOfDay`), so a partial month is never compared with a whole one.
  // `priorYears` lists the calendar years averaged into `priorYearAvg`.
  comparison: { priorMonth: number | null; priorYearAvg: number | null; priorYears: number[] };
  asOfDay: number | null;                 // day-of-month through which `month` is shown (null = a complete month)
  daysInMonth: number;
  dailyCumulative: { day: number; current: number | null; prior: number | null }[];
  importedCount: number;
  importedPending: number;                // imported rows not yet accepted (reviewed)
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

// --- CSV import (e.g. Monarch) ---------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  // Format from local components — the string parsed as local time, so
  // toISOString() would shift the date a day in timezones ahead of UTC.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function getImported() {
  ensureTables();
  const lab = getCategoryLabeler();
  const active = getActiveCategories();
  const rows = getDb().prepare('SELECT id, date, amount, payee, account, category, accepted FROM imported_txns ORDER BY accepted, date DESC').all() as
    { id: string; date: string; amount: number; payee: string; account: string; category: string | null; accepted: number }[];
  // Surface the category the budget would honor (alias-normalised, matched to an
  // active category, then display-labeled) so the picker value lines up with its options.
  return rows.map(r => {
    const norm = normalizeImportedCategory(r.category);
    const match = active.find(a => a.toLowerCase() === norm.toLowerCase());
    return { ...r, accepted: !!r.accepted, category: match ? lab.label(match) : (norm || null) };
  });
}
export function clearImported() {
  ensureTables();
  return getDb().prepare('DELETE FROM imported_txns').run().changes;
}
export function deleteImported(id: string) {
  ensureTables();
  getDb().prepare('DELETE FROM imported_txns WHERE id = ?').run(id);
}
// Recategorize a single imported row. The chosen (display) category is canonicalised
// so the merge in getCategorizedTransactions honors it.
export function updateImportedCategory(id: string, category: string) {
  ensureTables();
  const canon = getCategoryLabeler().canon(category.trim());
  getDb().prepare('UPDATE imported_txns SET category = ?, cat_edited = 1 WHERE id = ?').run(canon, id);
}
// Override a single transaction's amount (magnitude; sign is preserved on apply).
// Works for any transaction — bank-feed or imported — keyed by its id.
export function setTxnAmount(id: string, amount: number): void {
  ensureTables();
  getDb().prepare(`
    INSERT INTO txn_amount_overrides (id, amount) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET amount = excluded.amount
  `).run(id, Math.abs(amount));
}
// Clear a transaction's amount override, reverting to the original feed/import value.
export function clearTxnAmount(id: string): void {
  ensureTables();
  getDb().prepare('DELETE FROM txn_amount_overrides WHERE id = ?').run(id);
}

// Mark imported rows reviewed. With no id, accepts every still-pending row.
export function acceptImported(id?: string): number {
  ensureTables();
  const db = getDb();
  return id
    ? db.prepare('UPDATE imported_txns SET accepted = 1 WHERE id = ?').run(id).changes
    : db.prepare('UPDATE imported_txns SET accepted = 1 WHERE accepted = 0').run().changes;
}

// Physically delete imported transactions that duplicate a SimpleFIN transaction
// (matched on date | amount | merchant). Returns how many were removed.
const normAcct = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
function acctCompatible(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  return min >= 4 && (a.includes(b) || b.includes(a)); // e.g. "chasefreedom" ⊂ "chasefreedom"
}

export async function reconcileImported(): Promise<{ removed: number }> {
  ensureTables();
  const db = getDb();
  const sf = await getFeedTransactions();

  // Tier 1: exact date|amount|merchant. Tier 2 (fuzzy): date|amount with a
  // compatible account, ignoring merchant — catches differently-labeled payees.
  // Matching is one-to-one: each feed txn is consumed by at most one imported row,
  // so two genuine same-day same-amount imports aren't both deleted by one charge.
  const merchantKeyOf = (date: string, amount: number, merchant: string) => `${date}|${amount.toFixed(2)}|${merchant}`;
  type SfEntry = { acct: string; consumed: boolean };
  const sfByMerchantKey = new Map<string, SfEntry[]>();
  const sfDateAmt = new Map<string, SfEntry[]>(); // 'date|amount' -> feed txns (normalized accounts)
  for (const t of sf) {
    const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
    const e: SfEntry = { acct: normAcct(t.accountName), consumed: false };
    const mk = merchantKeyOf(date, t.amount, merchantKey(t.payee, t.description));
    (sfByMerchantKey.get(mk) ?? sfByMerchantKey.set(mk, []).get(mk)!).push(e);
    const da = `${date}|${t.amount.toFixed(2)}`;
    (sfDateAmt.get(da) ?? sfDateAmt.set(da, []).get(da)!).push(e);
  }

  const rows = db.prepare('SELECT id, date, amount, merchant, account FROM imported_txns').all() as
    { id: string; date: string; amount: number; merchant: string; account: string }[];
  const del = db.prepare('DELETE FROM imported_txns WHERE id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const r of rows) {
      let match = sfByMerchantKey.get(merchantKeyOf(r.date, r.amount, r.merchant))?.find(e => !e.consumed);
      if (!match) {
        const ra = normAcct(r.account);
        match = sfDateAmt.get(`${r.date}|${r.amount.toFixed(2)}`)?.find(e => !e.consumed && acctCompatible(e.acct, ra));
      }
      if (match) { match.consumed = true; del.run(r.id); removed++; }
    }
  })();
  return { removed };
}

export function importTransactions(csv: string): { imported: number; skipped: number } {
  ensureTables();
  const rows = parseCsv(csv).filter(r => r.some(c => c.trim() !== ''));
  if (rows.length < 2) return { imported: 0, skipped: 0 };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex(h => names.includes(h));
  const di = idx(['date', 'posted date', 'transaction date']);
  const mi = idx(['merchant', 'description', 'name', 'payee']);
  const ai = idx(['amount']);
  const acci = idx(['account', 'account name']);
  const ci = idx(['category']);
  if (di < 0 || ai < 0) throw new Error('CSV needs at least Date and Amount columns');

  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO imported_txns (id, date, amount, payee, merchant, account, category) VALUES (?,?,?,?,?,?,?)');
  let imported = 0, skipped = 0;
  const csvCats = new Set<string>();
  const seenIds = new Map<string, number>(); // base id -> occurrences so far in THIS file
  db.transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const date = normDate(row[di] ?? '');
      if (!date) { skipped++; continue; }
      // Accounting-style "($45.00)" means negative — capture the sign before
      // stripping the parentheses.
      // A blank or non-numeric amount can't be imported meaningfully, so skip it
      // rather than recording a $0 transaction.
      const rawAmt = (row[ai] ?? '').trim();
      const parenNeg = /^\(.*\)$/.test(rawAmt) ? -1 : 1;
      const parsedAmt = parseFloat(rawAmt.replace(/[$,()\s]/g, ''));
      if (!Number.isFinite(parsedAmt)) { skipped++; continue; }
      const amount = parsedAmt * parenNeg;
      const payee = (mi >= 0 ? row[mi] : '')?.trim() || 'Unknown';
      const account = (acci >= 0 ? row[acci] : '')?.trim() || 'Imported';
      const category = (ci >= 0 ? row[ci] : '')?.trim() || '';
      if (category) csvCats.add(category);
      const merchant = merchantKey(payee, '');
      // Dedup key (also matches SimpleFIN at read time): date|amount|merchant|account.
      const baseId = `imp|${date}|${amount.toFixed(2)}|${merchant}|${account.toLowerCase().slice(0, 20)}`;
      // Two genuinely identical rows in one file (same-day same-amount same-merchant
      // charges) must both import: the 2nd+ occurrence gets a `|n` suffix. The first
      // keeps the bare id, so re-importing an older file stays idempotent.
      const n = (seenIds.get(baseId) ?? 0) + 1;
      seenIds.set(baseId, n);
      const id = n === 1 ? baseId : `${baseId}|${n}`;
      const info = ins.run(id, date, amount, payee, merchant, account, category);
      info.changes > 0 ? imported++ : skipped++;
    }
  })();
  ensureImportedCategories(db, [...csvCats]); // keep any new Monarch categories from this import
  return { imported, skipped };
}

// Build the merged, categorized transaction list (SimpleFIN + imported, deduped,
// brokerage trades excluded). Shared by the monthly budget and the projection.
// Exported so recurring-bill detection sees the SAME merged, deduped, fully
// categorized ledger the Budget view does (SimpleFIN + imported documents) —
// otherwise imported-only bills (utilities, pool/maid/landscaping, etc.) never
// surface as recurring. Categories returned are canonical (un-renamed).
export async function getCategorizedTransactions(): Promise<BudgetTxn[]> {
  return (await categorize()).txns;
}

// Like getCategorizedTransactions, but also reports EVERY rule id whose conditions
// match each transaction (not just the one that decided it) — the Rules review
// uses this to find rules that are always out-ranked.
export async function getCategorizedWithRuleMatches(): Promise<{ txns: BudgetTxn[]; matches: Map<string, number[]> }> {
  const matches = new Map<string, number[]>();
  const { txns } = await categorize(matches);
  return { txns, matches };
}

async function categorize(matches?: Map<string, number[]>): Promise<{ txns: BudgetTxn[] }> {
  ensureTables();
  const db = getDb();
  // Exact-merchant / smart (merchant, amount, text combos) / base ("similar
  // merchants") rules — see matchingRules for the precedence.
  const ruleIdx = loadRuleIndex();
  // The rule deciding a transaction's category (first match), recording all matches
  // when asked. `text` is a pre-lowercased "payee description" blob.
  const pickRule = (id: string, merchant: string, text: string, amount: number): CategoryRuleRow | undefined => {
    let first: CategoryRuleRow | undefined;
    const all: number[] | undefined = matches ? [] : undefined;
    for (const r of matchingRules(ruleIdx, { merchant, text, amount })) {
      first ??= r;
      if (!all) break;
      all.push(r.id);
    }
    if (matches && all!.length) matches.set(id, all!);
    return first;
  };

  // Budgeting is about cash flow — exclude brokerage trades (buys/sells aren't spending).
  const acctCat = new Map(
    (db.prepare('SELECT id, category FROM accounts').all() as { id: string; category: string }[])
      .map(a => [a.id, a.category])
  );
  const activeSet = new Set(getActiveCategories());
  const isSignFlipped = getSignFlipMatcher(); // merchant → whether its sign is reversed
  const ruledIds = new Set<string>(); // txns whose category the user set explicitly
  const sfRaw = (await getFeedTransactions()).filter(t => acctCat.get(t.accountId) !== 'brokerage');
  const sfAll: BudgetTxn[] = sfRaw.map(t => {
    const m = merchantKey(t.payee, t.description);
    const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
    const flip = isSignFlipped(m);
    const amt = flip ? -t.amount : t.amount;
    const suggested = autoCategory(t.payee, t.description, amt); // rule-based guess, pre-override
    const rule = pickRule(t.id, m, `${t.payee} ${t.description}`.toLowerCase(), amt);
    const ruled = rule?.category as Category | undefined;
    if (ruled != null) ruledIds.add(t.id);
    let category = ruled ?? suggested;
    // Positive amounts in a liability account are payments, not income.
    if (ruled == null && amt > 0 && INCOME_SET.has(category) &&
        (acctCat.get(t.accountId) === 'credit' || LIABILITY_ACCT_RE.test(t.accountName))) {
      category = (acctCat.get(t.accountId) === 'credit' || CC_ACCT_RE.test(t.accountName)) ? 'Credit Card Payment' : 'Transfers';
    }
    if (!activeSet.has(category)) category = 'Miscellaneous';
    return { id: t.id, date, amount: amt, description: t.description, payee: displayPayee(t.payee, t.description), account: t.accountName, merchant: m, category, suggested, memo: t.memo, postedAt: t.posted, transactedAt: t.transactedAt, flipped: flip, ruleId: rule?.id ?? null, ruleSource: rule?.kind ?? 'auto' };
  });

  // Merge imported (Monarch etc.) transactions, dropping any that duplicate a
  // SimpleFIN transaction. A bank feed and a CSV export routinely disagree on a
  // transaction's posted date by a day or two AND word the merchant differently
  // ("Reformed Radiolo Payroll" vs "Reformed Radiology"), so the old exact
  // date|merchant match missed almost every real dupe — letting the same paycheck or
  // charge get counted twice and inflating income & spending. Match instead on the
  // same (pre-flip) amount within a few days, confirmed by EITHER a matching merchant
  // OR the same account (its trailing 4 digits) — each is a strong enough secondary
  // key on its own. Matching is one-to-one (each candidate is consumed once) so genuine
  // same-amount repeats — a daily coffee, a twice-weekly fare — aren't over-merged.
  const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');
  const postedDayMs = (posted: number) => dayMs(new Date(posted * 1000).toISOString().slice(0, 10));
  // `importedAcct` (lower-cased raw account string) marks entries that came from an
  // import; it lets us refuse to match two imported rows from the SAME account string.
  type DupEntry = DupTxn & { consumed: boolean; importedAcct?: string };
  const amountKey = (amount: number) => amount.toFixed(2);
  const byAmount = new Map<string, DupEntry[]>();
  const addEntry = (e: DupEntry) => {
    const k = amountKey(e.amount);
    (byAmount.get(k) ?? byAmount.set(k, []).get(k)!).push(e);
  };
  // Seed with SimpleFIN txns on their ORIGINAL (pre-flip) amount so a sign-reversal
  // rule never breaks SimpleFIN↔import matching.
  for (const t of sfRaw) addEntry({ amount: t.amount, day: postedDayMs(t.posted), merchant: merchantKey(t.payee, t.description), acct: acctLast4(t.accountName), consumed: false });
  // Find (and consume) an unmatched candidate that this imported row duplicates.
  // An earlier imported row with the same raw account string came from the same
  // export, so it's a distinct charge (two $4.50 coffees on Mon & Wed), never a dupe;
  // exact re-imports are already collapsed by the row id. Only cross-export
  // (different account string) and feed matches count.
  const consumeDuplicate = (r: DupTxn, importedAcct: string): boolean => {
    const cand = (byAmount.get(amountKey(r.amount)) ?? []).find(e =>
      !e.consumed && !(e.importedAcct !== undefined && e.importedAcct === importedAcct) && isDuplicateTxn(r, e));
    if (cand) { cand.consumed = true; return true; }
    return false;
  };

  const importedRows = db.prepare('SELECT * FROM imported_txns').all() as
    { id: string; date: string; amount: number; payee: string; merchant: string; account: string; category: string | null; cat_edited: number }[];
  const importedAll: BudgetTxn[] = [];
  for (const r of importedRows) {
    const dup: DupTxn = { amount: r.amount, day: dayMs(r.date), merchant: merchantKey(r.merchant, r.payee), acct: acctLast4(r.account) };
    const importedAcct = r.account.toLowerCase();
    if (consumeDuplicate(dup, importedAcct)) continue; // dup of a feed txn / kept import from another export
    // Keep it, and register it so a later import from a DIFFERENT export can dedup against it.
    addEntry({ ...dup, consumed: false, importedAcct });
    const flip = isSignFlipped(r.merchant);
    const amt = flip ? -r.amount : r.amount;
    const suggested = autoCategory(r.payee, '', amt);
    // An explicit per-row recategorization (cat_edited) is the most specific
    // user signal — it wins over merchant-level rules.
    const edited = r.cat_edited && r.category
      ? [...activeSet].find(a => a.toLowerCase() === normalizeImportedCategory(r.category!).toLowerCase())
      : undefined;
    const rule = edited ? undefined : pickRule(r.id, r.merchant, `${r.payee}`.toLowerCase(), amt);
    const ruled = edited ?? rule?.category;
    if (ruled != null) ruledIds.add(r.id);
    let cat = ruled as string | undefined;
    let ruleSource: RuleSource = rule?.kind ?? (edited ? 'import' : 'auto');
    if (!cat && r.category) {
      const norm = normalizeImportedCategory(r.category); // honor Monarch's category (aliases internal-money labels → Transfers)
      cat = [...activeSet].find(a => a.toLowerCase() === norm.toLowerCase());
      if (cat) ruleSource = 'import';
    }
    if (!cat) cat = suggested;
    // Positive amounts in a liability account are payments, not income.
    if (ruled == null && amt > 0 && INCOME_SET.has(cat) && LIABILITY_ACCT_RE.test(r.account)) cat = CC_ACCT_RE.test(r.account) ? 'Credit Card Payment' : 'Transfers';
    if (!activeSet.has(cat)) cat = 'Miscellaneous';
    importedAll.push({ id: r.id, date: r.date, amount: amt, description: r.payee, payee: displayPayee(r.payee, ''), account: r.account, merchant: r.merchant, category: cat as Category, suggested, memo: '', postedAt: Math.floor(Date.parse(r.date + 'T00:00:00Z') / 1000) || 0, transactedAt: null, flipped: flip, ruleId: rule?.id ?? null, ruleSource });
  }
  const all = [...sfAll, ...importedAll];
  detectTransferPairs(all, ruledIds); // flag matched cross-account transfer legs

  // Apply user amount overrides last (so dedup/transfer matching used real feed
  // amounts). The override is a magnitude; the transaction's sign is preserved.
  const amountOverrides = new Map(
    (db.prepare('SELECT id, amount FROM txn_amount_overrides').all() as { id: string; amount: number }[]).map(r => [r.id, r.amount])
  );
  if (amountOverrides.size) {
    for (const t of all) {
      const ov = amountOverrides.get(t.id);
      if (ov != null) { t.amount = (t.amount < 0 ? -1 : 1) * Math.abs(ov); t.amountEdited = true; }
    }
  }
  return { txns: all };
}

export async function getBudget(month?: string): Promise<BudgetSummary> {
  ensureTables();
  const db = getDb();
  const targets = new Map<string, { limit: number; period: 'monthly' | 'annual' }>(
    (db.prepare('SELECT category, monthly_limit, period FROM budget_targets').all() as { category: string; monthly_limit: number; period: string }[])
      .map(t => [t.category, { limit: t.monthly_limit, period: t.period === 'annual' ? 'annual' : 'monthly' }])
  );

  const all = await getCategorizedTransactions();
  // Treat a credit-card payment as an internal move (not spending) only in months
  // where the card's own transactions are tracked — otherwise the payment is the
  // sole record of that month's card spending.
  const trackedMonths = cardTrackedMonths(all);
  const internal = (c: string, ym: string) => isInternalTransfer(c, trackedMonths.has(ym));

  // Spending is accumulated as SIGNED spend (-amount: charges positive, refunds
  // negative) per category so a refund nets down its category, and each category's
  // total is then clamped at >= 0 (a refund bigger than the period's charges can't
  // produce negative spending). Every total below is the sum of those clamped
  // category totals, so headline numbers always agree with the per-category rows.
  // Spending per month (excludes income/transfers/mortgage) for prior-period comparisons.
  const monthCat = new Map<string, Map<string, number>>(); // month -> category -> signed spend
  for (const t of all) {
    if (INCOME_SET.has(t.category) || internal(t.category, t.date.slice(0, 7)) || t.category === 'Mortgage') continue;
    const mk = t.date.slice(0, 7);
    const cm = monthCat.get(mk) ?? monthCat.set(mk, new Map()).get(mk)!;
    cm.set(t.category, (cm.get(t.category) ?? 0) - t.amount);
  }
  const monthSpend = new Map<string, number>();
  for (const [mk, cm] of monthCat) {
    let sum = 0;
    for (const v of cm.values()) if (v >= 0.005) sum += v; // <1/2 cent is float dust from an exactly-refunded charge
    if (sum) monthSpend.set(mk, sum);
  }

  const months = [...new Set(all.map(t => t.date.slice(0, 7)))].sort().reverse();
  // On a fresh/sparse DB there are no months, so `months[0]` is undefined. Fall
  // back to the current month so the whole function computes a zeroed budget
  // (every loop over `all` is empty) instead of throwing on `target.slice(...)`.
  const target = (month && months.includes(month) ? month : months[0]) ?? new Date().toISOString().slice(0, 7);

  // Transfers are excluded from the budget transaction list. Mortgage is kept
  // (shown grayed/“excluded”) so it stays visible without affecting totals.
  const txns = all
    .filter(t => t.date.slice(0, 7) === target && !internal(t.category, target))
    .sort((a, b) => b.date.localeCompare(a.date));

  const allMonthTxns = all.filter(t => t.date.slice(0, 7) === target);
  const catMap = new Map<string, { total: number; count: number }>();
  let income = 0;
  let mortgage = 0;
  let mortgageCount = 0;
  for (const t of allMonthTxns) {
    if (INCOME_SET.has(t.category)) { income += t.amount; continue; }
    if (internal(t.category, target)) continue;
    // Mortgage cash regardless of sign — some sources post loan payments as positive.
    if (t.category === 'Mortgage') { mortgage += Math.abs(t.amount); mortgageCount += 1; continue; }
    const e = catMap.get(t.category) ?? { total: 0, count: 0 };
    e.total -= t.amount; // signed: expenses (negative amounts) add, refunds subtract
    if (t.amount < 0) e.count += 1; // count only the expense rows
    catMap.set(t.category, e);
  }
  // Clamp each category at >= 0 and drop empty ones; spending is the sum of what's left.
  let spending = 0;
  for (const [cat, e] of catMap) {
    if (e.total < 0.005) catMap.delete(cat); else spending += e.total;
  }

  // Year-to-date spend per category (calendar year of the viewed month, through
  // that month) — the relevant figure for annual budgets like Travel or Insurance.
  const yearPrefix = target.slice(0, 4);
  const ytdByCat = new Map<string, number>();
  for (const t of all) {
    if (t.date.slice(0, 4) !== yearPrefix || t.date.slice(0, 7) > target) continue;
    if (INCOME_SET.has(t.category) || internal(t.category, t.date.slice(0, 7)) || t.category === 'Mortgage') continue;
    ytdByCat.set(t.category, (ytdByCat.get(t.category) ?? 0) - t.amount); // signed; refunds net down
  }
  for (const [cat, v] of ytdByCat) ytdByCat.set(cat, Math.max(0, v));

  // Include every category that has spending OR a target (so budgets show even at $0 spent).
  // Mortgage is intentionally omitted here — it's appended below as an excluded row.
  const catNames = new Set<string>([...catMap.keys(), ...targets.keys()]);
  catNames.delete('Mortgage');
  const byCategory: BudgetSummary['byCategory'] = [...catNames]
    .map(category => {
      const tg = targets.get(category);
      return {
        category,
        spent: catMap.get(category)?.total ?? 0,
        count: catMap.get(category)?.count ?? 0,
        target: tg?.limit ?? 0,
        period: tg?.period ?? 'monthly',
        ytdSpent: ytdByCat.get(category) ?? 0,
      };
    })
    // Annual budgets sort on their year-to-date spend, monthly on the month's spend.
    .sort((a, b) => {
      const av = a.period === 'annual' ? a.ytdSpent : a.spent;
      const bv = b.period === 'annual' ? b.ytdSpent : b.spent;
      return bv - av || b.target - a.target;
    });

  // Mortgage stays visible as a grayed, excluded row (never counted in spending).
  if (mortgage > 0) {
    byCategory.push({ category: 'Mortgage', spent: mortgage, count: mortgageCount, target: 0, excluded: true });
  }

  const needsReview = txns.filter(t => t.category === 'Miscellaneous' && t.amount < 0);
  // Monthly-equivalent total (annual targets contribute 1/12).
  const totalBudget = [...targets.values()].reduce((s, t) => s + (t.period === 'annual' ? t.limit / 12 : t.limit), 0);

  // Comparisons: prior month, and average of the same calendar month in prior years.
  // While `target` is still in progress, compare like with like: the prior month(s)
  // are measured only through the same day of the month, not in full.
  const isCurrentMonth = target === new Date().toISOString().slice(0, 7);
  const todayDay = isCurrentMonth ? new Date().getUTCDate() : 31;
  const asOfDay = isCurrentMonth ? todayDay : null;
  const prevMonth = addMonths(target, -1);
  const mm = target.slice(5, 7);
  const yy = parseInt(target.slice(0, 4));
  const priorYearKeys = [...monthSpend.keys()].filter(k => k.slice(5, 7) === mm && parseInt(k.slice(0, 4)) < yy).sort();
  // Spend per month through `day` (same category netting/clamping as monthSpend).
  const spendThrough = (keys: string[], day: number): Map<string, number> => {
    const want = new Set(keys);
    const cats = new Map<string, Map<string, number>>();
    for (const t of all) {
      const mk = t.date.slice(0, 7);
      if (!want.has(mk) || parseInt(t.date.slice(8, 10)) > day) continue;
      if (INCOME_SET.has(t.category) || internal(t.category, mk) || t.category === 'Mortgage') continue;
      const cm = cats.get(mk) ?? cats.set(mk, new Map()).get(mk)!;
      cm.set(t.category, (cm.get(t.category) ?? 0) - t.amount);
    }
    const out = new Map<string, number>();
    for (const [mk, cm] of cats) {
      let sum = 0;
      for (const v of cm.values()) if (v >= 0.005) sum += v;
      out.set(mk, sum);
    }
    return out;
  };
  const through = isCurrentMonth ? spendThrough([prevMonth, ...priorYearKeys], todayDay) : null;
  const periodSpend = (k: string): number | null =>
    !monthSpend.has(k) ? null : through ? (through.get(k) ?? 0) : monthSpend.get(k)!;
  const priorMonth = periodSpend(prevMonth);
  const priorYearVals = priorYearKeys.map(k => periodSpend(k)!);
  const priorYearAvg = priorYearVals.length ? priorYearVals.reduce((a, b) => a + b, 0) / priorYearVals.length : null;
  const priorYears = priorYearKeys.map(k => parseInt(k.slice(0, 4)));

  // Cumulative spending by day-of-month: current month vs prior month.
  const cumByDay = (monthKey: string): number[] => {
    const daily = new Array(32).fill(0);
    for (const t of all) {
      if (t.date.slice(0, 7) !== monthKey || INCOME_SET.has(t.category) || internal(t.category, monthKey) || t.category === 'Mortgage') continue;
      daily[parseInt(t.date.slice(8, 10))] -= t.amount; // signed: refunds reduce the running total
    }
    const cum = new Array(32).fill(0);
    let run = 0;
    for (let d = 1; d <= 31; d++) { run += daily[d]; cum[d] = Math.max(0, run); }
    return cum;
  };
  const curCum = cumByDay(target);
  const priorCum = cumByDay(prevMonth);
  const md = daysInMonth(target);
  const dailyCumulative = [];
  for (let d = 1; d <= md; d++) {
    dailyCumulative.push({ day: d, current: d <= todayDay ? curCum[d] : null, prior: priorCum[d] || null });
  }

  const importedCount = (db.prepare('SELECT COUNT(*) AS n FROM imported_txns').get() as { n: number }).n;
  const importedPending = (db.prepare('SELECT COUNT(*) AS n FROM imported_txns WHERE accepted = 0').get() as { n: number }).n;

  // Apply display labels to category fields (canonical → renamed) for the UI.
  const lab = getCategoryLabeler();
  const labelTxn = (t: BudgetTxn): BudgetTxn => ({ ...t, category: lab.label(t.category), suggested: lab.label(t.suggested) });

  // Most-recent transactions across all months (newest first) for the overview's
  // "Recent transactions" card. Excludes internal moves (Transfers / Credit Card
  // Payment), like the rest of budgeting.
  const recent = all
    .filter(t => !internal(t.category, t.date.slice(0, 7)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.postedAt - a.postedAt)
    .slice(0, 12)
    .map(labelTxn);

  return {
    months, month: target,
    transactions: txns.map(labelTxn),
    byCategory: byCategory.map(c => ({ ...c, category: lab.label(c.category) })),
    needsReview: needsReview.map(labelTxn),
    recent,
    income, spending, mortgage, housing: realEstateCarry(), totalBudget,
    comparison: { priorMonth, priorYearAvg, priorYears }, asOfDay, daysInMonth: md, dailyCumulative, importedCount, importedPending,
  };
}

// Flat transaction list for the All-transactions tab. `range` is 'all' or a
// YYYY-MM month. Excludes Transfers (internal moves); keeps Mortgage. Returns the
// available months so the period selector can populate without a second call.
export async function getTransactionsList(range = 'all'): Promise<{ months: string[]; transactions: BudgetTxn[] }> {
  ensureTables();
  const lab = getCategoryLabeler();
  const all = await getCategorizedTransactions();
  const months = [...new Set(all.map(t => t.date.slice(0, 7)))].sort().reverse();
  let txns = all.filter(t => !isExcluded(t.category));
  if (range !== 'all' && /^\d{4}-\d{2}$/.test(range)) txns = txns.filter(t => t.date.slice(0, 7) === range);
  txns = txns.slice().sort((a, b) => b.date.localeCompare(a.date) || b.postedAt - a.postedAt);
  return { months, transactions: txns.map(t => ({ ...t, category: lab.label(t.category), suggested: lab.label(t.suggested) })) };
}

// --- Quick-review wizard ----------------------------------------------------
// One merchant cluster to review, with one-click category suggestions. Reviewing
// by merchant (grouped on the normalised base) — not by row — is the fast path:
// a single decision categorizes every transaction in the cluster, and (via an
// "apply to all" base rule) sweeps similar merchants too.
export interface ReviewTxn {
  id: string;               // transaction id, so its amount is editable in the wizard
  date: string; amount: number; account: string;
  description: string;      // raw bank descriptor (e.g. "AMAZON MKTPL*BV0QU8OW2")
  memo: string;
  importedCategory: string; // original CSV category for imported rows, else ''
  suggested: string;        // auto keyword guess for this row (display label)
  postedAt: number;         // unix seconds (time-of-day), 0 if unknown
  transactedAt: number | null; // unix seconds the purchase actually happened, else null
  amountEdited?: boolean;   // the amount is a user override
}
export interface ReviewGroup {
  merchant: string;     // representative raw merchant key (what the rule targets)
  payee: string;        // display label
  account: string;      // a representative account
  count: number;        // transactions in this cluster
  total: number;        // summed absolute amount
  lastDate: string;     // most recent date (YYYY-MM-DD)
  suggested: string;    // the top (keyword) guess, '' if none — shown starred
  suggestions: string[]; // ranked one-click categories (display labels)
  note: string;         // a raw descriptor that adds detail beyond the payee, '' if none
  txns: ReviewTxn[];    // the underlying charges (most-recent first, capped)
}

// Build the all-time review queue: uncategorized expenses grouped by merchant,
// each with ranked probable categories for one-click assignment.
export async function getReviewQueue(): Promise<{ groups: ReviewGroup[]; topCategories: string[] }> {
  ensureTables();
  const lab = getCategoryLabeler();
  const all = await getCategorizedTransactions();

  // Rank candidate categories by how often the user already uses them (real
  // expense categories only — never the catch-all, transfers, mortgage or income).
  const freq = new Map<string, number>();
  for (const t of all) {
    if (t.category === 'Miscellaneous' || isExcluded(t.category) || t.category === 'Mortgage' || INCOME_SET.has(t.category)) continue;
    freq.set(t.category, (freq.get(t.category) ?? 0) + 1);
  }
  const activeSet = new Set(getActiveCategories());
  const topCategories = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  // Sensible defaults so a fresh install (no history yet) still offers useful buttons.
  for (const d of ['Groceries', 'Restaurants & Bars', 'Shopping', 'Gas', 'Coffee Shops', 'Subscriptions']) {
    if (activeSet.has(d) && !topCategories.includes(d)) topCategories.push(d);
  }

  // The only extra signal imported (CSV) rows carry is the original category
  // column — for aggregators like PayPal the underlying merchant isn't in the
  // payee or description, so surface what Monarch/etc. labeled it.
  const importedCat = new Map<string, string>(
    (getDb().prepare('SELECT id, category FROM imported_txns').all() as { id: string; category: string | null }[])
      .filter(r => r.category && r.category.trim()).map(r => [r.id, r.category!.trim()])
  );

  // Cluster uncategorized expenses by normalised merchant base (falling back to
  // the raw merchant when the base is too thin to be a reliable key).
  const byKey = new Map<string, BudgetTxn[]>();
  for (const t of all) {
    if (t.category !== 'Miscellaneous' || t.amount >= 0) continue;
    const b = merchantBase(t.merchant);
    const key = usableBase(b) ? 'base:' + b : 'm:' + t.merchant;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(t);
  }

  const groups: ReviewGroup[] = [];
  for (const txns of byKey.values()) {
    const total = txns.reduce((s, t) => s + Math.abs(t.amount), 0);
    const lastDate = txns.reduce((d, t) => (t.date > d ? t.date : d), txns[0].date);
    // Representative merchant = the most common raw merchant in the cluster, so the
    // exact-merchant rule lands on the dominant variant.
    const mfreq = new Map<string, number>();
    for (const t of txns) mfreq.set(t.merchant, (mfreq.get(t.merchant) ?? 0) + 1);
    const merchant = [...mfreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rep = txns.find(t => t.merchant === merchant)!;
    const sug = rep.suggested && rep.suggested !== 'Miscellaneous' && activeSet.has(rep.suggested) ? rep.suggested : '';
    const ranked = [sug, ...topCategories].filter((c, i, a) => c && a.indexOf(c) === i).slice(0, 6);
    // A raw descriptor that says more than the cleaned payee (e.g. "AMAZON MKTPL*…").
    const note = txns.map(t => t.description).find(dsc => dsc && dsc.toLowerCase() !== rep.payee.toLowerCase()) ?? '';
    const reviewTxns: ReviewTxn[] = txns
      .slice().sort((a, b) => b.date.localeCompare(a.date) || b.postedAt - a.postedAt).slice(0, 40)
      .map(t => ({
        id: t.id, date: t.date, amount: t.amount, account: t.account,
        description: t.description, memo: t.memo, importedCategory: importedCat.get(t.id) ?? '',
        suggested: lab.label(t.suggested), postedAt: t.postedAt, transactedAt: t.transactedAt,
        amountEdited: t.amountEdited,
      }));
    groups.push({
      merchant, payee: rep.payee, account: rep.account,
      count: txns.length, total, lastDate,
      suggested: sug ? lab.label(sug) : '',
      suggestions: ranked.map(c => lab.label(c)),
      note, txns: reviewTxns,
    });
  }
  // Biggest impact first: most transactions, then largest dollar amount.
  groups.sort((a, b) => b.count - a.count || b.total - a.total);
  return { groups, topCategories: topCategories.slice(0, 8).map(c => lab.label(c)) };
}

export interface SpendingProjection {
  months: { month: string; spending: number; income: number }[]; // complete months, chronological
  monthsAnalyzed: number;          // # of complete months used for the averages (≤ 12)
  avgMonthlySpending: number;      // trailing average over monthsAnalyzed
  avgMonthlyIncome: number;
  trendPctPerYear: number;         // annualized spending trend from a linear fit (e.g. 0.04 = +4%/yr)
  byCategory: { category: string; avgMonthly: number }[]; // trailing per-category averages, desc
}

// Project recurring expenses (and income) from actual transaction history.
// Uses complete months only — the current, partial month would understate the
// average — and weights the trailing 12 months for a stable, recent estimate.
export async function getSpendingProjection(): Promise<SpendingProjection> {
  const all = await getCategorizedTransactions();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const projTrackedMonths = cardTrackedMonths(all);

  // Aggregate per month: total spending, income, and per-category spend. The
  // current (in-progress) month IS included in the series so the chart shows it,
  // but it's excluded from the trailing averages/trend below (a partial month
  // would understate them). Future-dated rows are skipped entirely.
  // Spend is accumulated signed per category-month (refunds net down their
  // category), then each category-month is clamped at >= 0; spendByMonth is the sum
  // of those clamped values so it matches the per-category figures.
  const spendByMonth = new Map<string, number>();
  const incomeByMonth = new Map<string, number>();
  const catByMonth = new Map<string, Map<string, number>>(); // month -> category -> spend
  for (const t of all) {
    const ym = t.date.slice(0, 7);
    if (ym > thisMonth) continue; // skip future-dated rows
    // Same card-payment rule as getBudget/getCashFlow: a payment only counts as
    // an internal move in months where the card's own purchases are tracked.
    if (isInternalTransfer(t.category, projTrackedMonths.has(ym)) || t.category === 'Mortgage') continue;
    if (INCOME_SET.has(t.category)) { incomeByMonth.set(ym, (incomeByMonth.get(ym) ?? 0) + t.amount); continue; }
    const cm = catByMonth.get(ym) ?? new Map<string, number>();
    cm.set(t.category, (cm.get(t.category) ?? 0) - t.amount);
    catByMonth.set(ym, cm);
  }
  for (const [ym, cm] of catByMonth) {
    let sum = 0;
    for (const [cat, v] of cm) {
      if (v < 0.005) { cm.delete(cat); continue; }
      sum += v;
    }
    if (sum > 0) spendByMonth.set(ym, sum); else catByMonth.delete(ym);
  }

  const allMonths = [...new Set([...spendByMonth.keys(), ...incomeByMonth.keys()])].sort();
  const months = allMonths.map(m => ({
    month: m,
    spending: Math.round(spendByMonth.get(m) ?? 0),
    income: Math.round(incomeByMonth.get(m) ?? 0),
  }));

  // Trailing window for the averages/trend — COMPLETE months only (drop the
  // current partial month so it doesn't drag the figures down).
  const window = allMonths.filter(m => m < thisMonth).slice(-12);
  const monthsAnalyzed = window.length;
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  const avgMonthlySpending = avg(window.map(m => spendByMonth.get(m) ?? 0));
  const avgMonthlyIncome = avg(window.map(m => incomeByMonth.get(m) ?? 0));

  // Annualized spending trend via least-squares fit over the window (x in months).
  let trendPctPerYear = 0;
  if (monthsAnalyzed >= 3 && avgMonthlySpending > 0) {
    const ys = window.map(m => spendByMonth.get(m) ?? 0);
    const n = ys.length;
    const xMean = (n - 1) / 2;
    const yMean = avg(ys);
    let num = 0, den = 0;
    ys.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
    const slopePerMonth = den ? num / den : 0; // $/month change
    trendPctPerYear = (slopePerMonth * 12) / avgMonthlySpending;
  }

  // Per-category trailing average (spend only in window months it appeared).
  const projLabeler = getCategoryLabeler();
  const catTotals = new Map<string, number>();
  for (const m of window) for (const [cat, v] of catByMonth.get(m) ?? []) catTotals.set(cat, (catTotals.get(cat) ?? 0) + v);
  const byCategory = [...catTotals.entries()]
    .map(([category, total]) => ({ category: projLabeler.label(category), avgMonthly: Math.round(total / Math.max(1, monthsAnalyzed)) }))
    .filter(c => c.avgMonthly > 0)
    .sort((a, b) => b.avgMonthly - a.avgMonthly);

  return {
    months,
    monthsAnalyzed,
    avgMonthlySpending: Math.round(avgMonthlySpending),
    avgMonthlyIncome: Math.round(avgMonthlyIncome),
    trendPctPerYear: Math.round(trendPctPerYear * 1000) / 1000,
    byCategory,
  };
}

// --- Smart rule suggestions -------------------------------------------------


export interface RuleSpec { base?: string; contains?: string; amount?: number }
// One composable condition. The user ANDs any subset into a single rule.
export interface RuleCondition { key: string; kind: 'merchant' | 'amount' | 'text'; label: string; spec: RuleSpec; count: number }

// Count transactions matching ALL set conditions in a spec (AND).
function countSpec(all: BudgetTxn[], spec: RuleSpec): number {
  const base = spec.base ?? null;
  const contains = spec.contains ? spec.contains.toLowerCase() : null;
  const amount = spec.amount != null && !isNaN(spec.amount) ? Math.abs(spec.amount) : null;
  if (base == null && contains == null && amount == null) return 0;
  let n = 0;
  for (const t of all) {
    if (base != null && merchantBase(t.merchant) !== base) continue;
    if (contains && !`${t.payee} ${t.description}`.toLowerCase().includes(contains)) continue;
    if (amount != null && Math.abs(t.amount).toFixed(2) !== amount.toFixed(2)) continue;
    n++;
  }
  return n;
}

// Boilerplate tokens that never make good "text contains" rules on their own.
const KW_STOP = new Set([
  'the', 'and', 'llc', 'inc', 'corp', 'ltd', 'pos', 'debit', 'credit', 'card', 'purchase',
  'payment', 'web', 'ach', 'pmt', 'paypal', 'sq', 'tst', 'online', 'intl', 'usa', 'com',
  'www', 'store', 'shop', 'recurring', 'autopay', 'bill', 'checkcard', 'visa', 'mastercard',
]);
// Distinctive alphabetic tokens from a payee+description, longest (most specific) first.
function keywordCandidates(payee: string, description: string): string[] {
  const toks = `${payee} ${description}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .filter(t => t.length >= 4 && /^[a-z]+$/.test(t) && !KW_STOP.has(t)); // pure-alpha, drops ref ids
  return [...new Set(toks)].sort((a, b) => b.length - a.length).slice(0, 3);
}

// Given a just-categorized transaction, propose composable conditions (merchant,
// exact amount, description text). The client ANDs any subset into ONE precise
// rule — combining conditions narrows the match, avoiding the over-broad results
// of applying each as a separate (OR) rule. Each condition reports its own
// standalone reach; the combined (AND) count is computed live via countRule.
export async function suggestRules(input: {
  merchant: string; payee?: string; description?: string; amount: number; category: string;
}): Promise<{ category: string; conditions: RuleCondition[] }> {
  ensureTables();
  const all = await getCategorizedTransactions();
  const base = merchantBase(input.merchant);
  const amt = Math.abs(input.amount);
  const payee = input.payee || input.merchant;
  const fmtAmt = (n: number) => '$' + n.toFixed(2);
  const conditions: RuleCondition[] = [];

  if (usableBase(base)) {
    conditions.push({ key: 'merchant', kind: 'merchant', label: `Merchant is “${payee}”`, spec: { base }, count: countSpec(all, { base }) });
  }
  if (amt >= 1) {
    conditions.push({ key: 'amount', kind: 'amount', label: `Amount is exactly ${fmtAmt(amt)}`, spec: { amount: amt }, count: countSpec(all, { amount: amt }) });
  }
  for (const kw of keywordCandidates(payee, input.description ?? '')) {
    if (kw === base) continue; // already covered by the merchant condition
    const count = countSpec(all, { contains: kw });
    if (count >= 1) conditions.push({ key: 'text:' + kw, kind: 'text', label: `Text contains “${kw}”`, spec: { contains: kw }, count });
  }
  return { category: input.category, conditions };
}

// Count how many transactions an AND-combination of conditions covers — drives
// the live count as the user toggles conditions in the rule builder.
export async function countRule(spec: RuleSpec): Promise<{ count: number }> {
  ensureTables();
  const all = await getCategorizedTransactions();
  return { count: countSpec(all, spec) };
}

// Persist chosen smart rules and report how many existing transactions they cover.
export async function applySmartRules(
  rules: { base?: string | null; contains?: string | null; amount?: number | null; category: string }[],
): Promise<{ matched: number; applied: number }> {
  ensureTables();
  const db = getDb();
  const lab = getCategoryLabeler();
  const active = new Set(getActiveCategories());
  const normed = rules.map(r => {
    const canon = lab.canon(r.category);
    return {
      base: r.base ?? null,
      contains: r.contains ? r.contains.trim().toLowerCase() : null,
      amount: r.amount != null && !isNaN(r.amount) ? Math.abs(r.amount) : null,
      category: active.has(canon) ? canon : 'Miscellaneous',
    };
  }).filter(r => r.base || r.contains || r.amount != null);

  const all = await getCategorizedTransactions();
  const matched = new Set<string>();
  for (const r of normed) {
    for (const t of all) {
      if (r.base != null && merchantBase(t.merchant) !== r.base) continue;
      if (r.contains && !`${t.payee} ${t.description}`.toLowerCase().includes(r.contains)) continue;
      if (r.amount != null && Math.abs(t.amount).toFixed(2) !== r.amount.toFixed(2)) continue;
      matched.add(t.id);
    }
  }
  const ins = db.prepare(`INSERT INTO rules (kind, base, contains, amount, category) VALUES ('smart', ?, ?, ?, ?)`);
  db.transaction(() => { for (const r of normed) ins.run(r.base, r.contains, r.amount, r.category); })();
  return { matched: matched.size, applied: normed.length };
}

/**
 * Categorize a merchant. `scope: 'one'` sets only the exact-merchant rule (every
 * transaction from that merchant); `scope: 'all'` additionally writes a base rule
 * that propagates to "similar" merchants (same normalised base — e.g. different
 * store numbers/punctuation of the same brand), existing and future. The
 * exact-merchant rule always wins over the base rule. Either way returns how many
 * OTHER transactions a base rule would cover, so the UI can offer/estimate the
 * "apply to all" action. Validates against the active category set.
 */
export async function applyCategoryRule(
  merchant: string,
  category: string,
  scope: 'one' | 'all' = 'all',
): Promise<{ similarTxns: number; similarMerchants: number; base: string; merchantTxns: number }> {
  ensureTables();
  const db = getDb();
  const canon = getCategoryLabeler().canon(category); // accept display labels too
  const cat = new Set(getActiveCategories()).has(canon) ? canon : 'Miscellaneous';
  // Normalise exactly like merchantKey (trim BEFORE slice). The UI sends back an
  // already-normalised stored key, which — being cut at 40 chars — can legitimately
  // end in a space; re-trimming it would never match the stored merchant. So a
  // 40-char value with no leading whitespace is taken as an existing key verbatim.
  const lower = merchant.toLowerCase();
  const key = lower.length === 40 && lower === lower.trimStart() ? lower : lower.trim().slice(0, 40);

  db.prepare(`INSERT OR REPLACE INTO rules (kind, merchant, category) VALUES ('merchant', ?, ?)`).run(key, cat);

  // How many existing transactions the exact-merchant rule just moved — the UI says
  // so ("Moved all 14 Amazon transactions to Gifts"), since the rule is merchant-wide.
  const txns = await getCategorizedTransactions();
  const merchantTxns = txns.reduce((n, t) => n + (t.merchant === key ? 1 : 0), 0);

  const base = merchantBase(key);
  if (!usableBase(base)) return { similarTxns: 0, similarMerchants: 0, base: '', merchantTxns };
  if (scope === 'all') {
    db.prepare(`INSERT OR REPLACE INTO rules (kind, base, category) VALUES ('base', ?, ?)`).run(base, cat);
  }

  // Count the other current transactions a base rule covers (excluding merchants
  // that carry their own explicit exact rule, and the merchant we just set).
  const ruled = new Set(
    (db.prepare(`SELECT merchant FROM rules WHERE kind = 'merchant'`).all() as { merchant: string }[]).map(r => r.merchant)
  );
  const merchants = new Set<string>();
  let similarTxns = 0;
  for (const t of txns) {
    if (t.merchant === key || ruled.has(t.merchant)) continue;
    if (merchantBase(t.merchant) !== base) continue;
    merchants.add(t.merchant);
    similarTxns++;
  }
  return { similarTxns, similarMerchants: merchants.size, base, merchantTxns };
}

// --- Cash-flow Sankey -------------------------------------------------------
// A 4-tier money-flow graph: income sources → Income → spending groups + Savings
// → categories. Groups reuse the same taxonomy as the category picker. Transfers
// (internal moves) are excluded; Mortgage IS included since it's real cash out —
// unlike the Overview's "Spent", which leaves it out (the UI captions the difference).

export type NodeFilter =
  | { type: 'income' }
  | { type: 'source'; value: string }   // income source payee, or '__other'
  | { type: 'group'; value: string }
  | { type: 'category'; value: string }
  | { type: 'savings' };
export interface SankeyNode { name: string; color: string; col: number; kind: 'source' | 'hub' | 'savings' | 'group' | 'category'; filter: NodeFilter }
export interface SankeyLink { source: number; target: number; value: number }
export interface CashFlow {
  range: string; label: string;
  span: { from: string | null; to: string }; // actual date span covered (YYYY-MM-DD); `from` is null with no data
  income: number; spending: number; savings: number;
  mortgage: number;                          // the part of `spending` that is mortgage payments
  nodes: SankeyNode[]; links: SankeyLink[];
}
export interface CashTxn { id: string; date: string; payee: string; merchant: string; account: string; category: string; suggested: string; amount: number; description: string; memo: string; postedAt: number; transactedAt: number | null; amountEdited?: boolean }

const INCOME_COLOR = GROUP_COLOR['Income'] ?? '#22b8cf';
const SAVINGS_COLOR = '#4ade80';
// Expense category → display group + group colors are derived from TAXONOMY
// (CATEGORY_GROUP / GROUP_COLOR, defined at the top). Unmapped categories fall
// into the "Other" group.

function rangeBounds(range: string): { start: string | null; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  switch (range) {
    case '1m': return { start: iso(new Date(Date.UTC(y, m, 1))), label: 'This month' };
    case '3m': return { start: iso(new Date(Date.UTC(y, m - 2, 1))), label: 'Last 3 months' };
    case '6m': return { start: iso(new Date(Date.UTC(y, m - 5, 1))), label: 'Last 6 months' };
    case 'ytd': return { start: iso(new Date(Date.UTC(y, 0, 1))), label: 'Year to date' };
    case '12m': return { start: iso(new Date(Date.UTC(y, m - 11, 1))), label: 'Last 12 months' };
    default: return { start: null, label: 'All time' };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// True when at least one connected credit-card account actually carries transactions
// in `txns` — i.e. its purchases are tracked and already counted as spending, so the
// matching bank-account payments are internal moves we can safely exclude. With no
// such card connected, card payments are the only signal of that spending.
// A card is recognised by its account category ('credit') OR a card-shaped account
// name, so a mislabelled card whose purchases we already count can't get double-billed.
function cardAccountNames(): Set<string> {
  return new Set(
    (getDb().prepare('SELECT name, category FROM accounts').all() as { name: string; category: string }[])
      .filter(a => a.category === 'credit' || CC_ACCT_RE.test(a.name))
      .map(a => a.name)
  );
}
function creditCardIsTracked(txns: { account: string }[]): boolean {
  const cardNames = cardAccountNames();
  if (cardNames.size === 0) return false;
  return txns.some(t => cardNames.has(t.account));
}

// Months in which a tracked card's own transactions actually appear. A card
// connected today typically has only ~90 days of history, so older months must
// still count their card payments as spending — the purchases they funded
// aren't in the ledger for those months.
function cardTrackedMonths(txns: { account: string; date: string }[]): Set<string> {
  const cardNames = cardAccountNames();
  const out = new Set<string>();
  if (cardNames.size === 0) return out;
  for (const t of txns) if (cardNames.has(t.account)) out.add(t.date.slice(0, 7));
  return out;
}

export async function getCashFlow(range = '12m', detail = false): Promise<CashFlow> {
  ensureTables();
  const cashLabeler = getCategoryLabeler();
  const { start, label } = rangeBounds(range);
  const all = await getCategorizedTransactions();
  const txns = all.filter(t => !start || t.date >= start);
  // When no credit card is connected, treat card payments as real spending (their
  // purchases aren't tracked anywhere else) — otherwise savings is overstated.
  const cardTracked = creditCardIsTracked(txns);

  // Income transactions (merged into employer sources below); expenses netted per category.
  const incomeTx: typeof txns = [];
  const catSpend = new Map<string, number>();
  for (const t of txns) {
    if (isInternalTransfer(t.category, cardTracked)) continue; // internal moves
    if (INCOME_SET.has(t.category)) {
      if (t.amount > 0) incomeTx.push(t);
      continue;
    }
    catSpend.set(t.category, (catSpend.get(t.category) ?? 0) - t.amount); // signed: refunds net down the category
  }
  // A category whose refunds exceed its charges bottoms out at 0 (never negative
  // spend); spending below is the sum of these clamped totals.
  for (const [cat, v] of catSpend) {
    if (v < 0.005) catSpend.delete(cat);
  }
  const { ordered: incomeSources } = buildIncomeSources(incomeTx);
  const income = incomeSources.reduce((s, x) => s + x.amount, 0);
  const spending = [...catSpend.values()].reduce((a, b) => a + b, 0);
  const savings = income - spending;

  const nodes: SankeyNode[] = [];
  const idx = new Map<string, number>();
  const links: SankeyLink[] = [];
  const add = (key: string, name: string, color: string, col: number, kind: SankeyNode['kind'], filter: NodeFilter) => {
    const existing = idx.get(key);
    if (existing != null) return existing;
    const i = nodes.length;
    nodes.push({ name, color, col, kind, filter });
    idx.set(key, i);
    return i;
  };

  const incomeIdx = add('hub', 'Income', INCOME_COLOR, 1, 'hub', { type: 'income' });

  // Tier 0: income sources — top employers (payroll variants already merged),
  // remainder pooled into "Other income".
  for (const s of incomeSources.slice(0, SOURCE_TOP)) {
    const si = add('src:' + s.key, s.label, INCOME_COLOR, 0, 'source', { type: 'source', value: s.key });
    links.push({ source: si, target: incomeIdx, value: round2(s.amount) });
  }
  const restAmt = incomeSources.slice(SOURCE_TOP).reduce((s, x) => s + x.amount, 0);
  if (restAmt > 0) {
    const si = add('src:__other', 'Other income', INCOME_COLOR, 0, 'source', { type: 'source', value: '__other' });
    links.push({ source: si, target: incomeIdx, value: round2(restAmt) });
  }

  // Savings (only when income exceeds spending). Col 2 — a sibling of the
  // spending groups, fed straight from Income, so it flows out in a single hop
  // rather than jumping across the leaf column.
  if (savings > 0) {
    const sv = add('savings', 'Savings', SAVINGS_COLOR, 2, 'savings', { type: 'savings' });
    links.push({ source: incomeIdx, target: sv, value: round2(savings) });
  }

  // Tier 2 → Tier 3: spending groups → their categories, largest first.
  const cashGroupOf = getCategoryGroupMap();
  const groupCats = new Map<string, Map<string, number>>();
  for (const [c, v] of catSpend) {
    if (v <= 0) continue;
    const g = cashGroupOf[c] ?? defaultGroupOf(c);
    const inner = groupCats.get(g) ?? new Map<string, number>();
    inner.set(c, v);
    groupCats.set(g, inner);
  }
  const groupsOrdered = [...groupCats.entries()]
    .map(([g, inner]) => ({ g, inner, total: [...inner.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  for (const { g, total } of groupsOrdered) {
    const gi = add('grp:' + g, g, groupColorOf(g), 2, 'group', { type: 'group', value: g });
    links.push({ source: incomeIdx, target: gi, value: round2(total) });
  }

  // Tier 3: break each group into all of its categories (largest first). The client
  // renders these only for the one group the user has expanded, and zooms in — so
  // even small categories get room to show — hence no pooling here.
  if (detail) {
    for (const { g, inner } of groupsOrdered) {
      const color = groupColorOf(g);
      const gi = idx.get('grp:' + g)!;
      for (const [c, v] of [...inner.entries()].sort((a, b) => b[1] - a[1])) {
        // Display the emoji + renamed label; keep the canonical name in the click filter.
        const emoji = cashLabeler.emoji(c) ?? TAX_EMOJI[c] ?? suggestEmoji(c);
        const ci = add('cat:' + c, `${emoji} ${cashLabeler.label(c)}`, color, 3, 'category', { type: 'category', value: c });
        links.push({ source: gi, target: ci, value: round2(v) });
      }
    }
  }

  const from = start ?? (txns.length ? txns.reduce((m, t) => (t.date < m ? t.date : m), txns[0].date) : null);
  const span = { from, to: new Date().toISOString().slice(0, 10) };
  return { range, label, span, income: round2(income), spending: round2(spending), savings: round2(savings), mortgage: round2(catSpend.get('Mortgage') ?? 0), nodes, links };
}

// Transactions behind a clicked Sankey node/band, for the drill-down table.
export async function getCashFlowTransactions(range: string, type: string, value?: string): Promise<{ label: string; total: number; txns: CashTxn[] }> {
  ensureTables();
  const lab = getCategoryLabeler();
  const { start } = rangeBounds(range);
  const all = await getCategorizedTransactions();
  const periodTxns = all.filter(t => !start || t.date >= start);
  // Mirror getCashFlow: card payments only count as internal moves when the card is tracked.
  const cardTracked = creditCardIsTracked(periodTxns);
  const inRange = periodTxns.filter(t => !isInternalTransfer(t.category, cardTracked));
  const incomeTx = inRange.filter(t => INCOME_SET.has(t.category) && t.amount > 0);

  let txns = inRange;
  let label = '';
  if (type === 'savings') {
    return { label: 'Savings', total: 0, txns: [] }; // savings is income − spending, not a txn set
  } else if (type === 'income') {
    txns = incomeTx; label = 'Income';
  } else if (type === 'source') {
    // Reverse the employer merge to find which transactions feed the clicked source.
    const { ordered, keyOfMerchant } = buildIncomeSources(incomeTx);
    if (value === '__other') {
      const top = new Set(ordered.slice(0, SOURCE_TOP).map(s => s.key));
      txns = incomeTx.filter(t => !top.has(keyOfMerchant.get(t.merchant) ?? '')); label = 'Other income';
    } else {
      txns = incomeTx.filter(t => (keyOfMerchant.get(t.merchant) ?? '') === value);
      label = ordered.find(s => s.key === value)?.label ?? 'Income source';
    }
  } else if (type === 'group') {
    const gOf = getCategoryGroupMap();
    txns = inRange.filter(t => !INCOME_SET.has(t.category) && (gOf[t.category] ?? defaultGroupOf(t.category)) === value); label = value ?? 'Group';
  } else if (type === 'category') {
    txns = inRange.filter(t => t.category === value); label = value ? lab.label(value) : 'Category';
  } else {
    txns = [];
  }

  txns = txns.slice().sort((a, b) => b.date.localeCompare(a.date));
  const total = round2(txns.reduce((s, t) => s + Math.abs(t.amount), 0));
  return {
    label, total,
    txns: txns.map(t => ({ id: t.id, date: t.date, payee: t.payee, merchant: t.merchant, account: t.account, category: lab.label(t.category), suggested: lab.label(t.suggested), amount: t.amount, description: t.description, memo: t.memo, postedAt: t.postedAt, transactedAt: t.transactedAt, amountEdited: t.amountEdited })),
  };
}
