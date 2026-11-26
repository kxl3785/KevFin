import { getDb } from '../db/schema.js';
import { fetchHoldings } from './simplefin.js';
import { effectiveChain, fetchDailyCloses, closeAsOf } from './prices.js';
import { fetchSecurityMeta, type SecurityMeta, type FundComposition } from './yahooMeta.js';
import { fetchDeepConstituents, mergeConstituents, type Constituent } from './fundHoldings.js';
import { lump } from './edgarHoldings.js';
import { fetchSecCompanyProfile } from './secCompany.js';
import { getHoldingProfiles, type MixPart } from './holdingProfiles.js';
import { countryCode, canonicalCountryName } from './country.js';
import { getLookThroughIssue, type LookThroughIssue } from './edgarHoldings.js';

export interface Contributor { label: string; value: number }
// code: ISO 3166-1 alpha-2, set on byCountry slices that are real countries (the
// map matches geometry by it); absent for pseudo-buckets like 'Crypto'.
export interface Slice { name: string; value: number; pct: number; contributors: Contributor[]; code?: string }
// costBasis is per-account on AccountHolding so a position can be expanded to
// show which accounts contributed (and which are missing a basis).
export interface AccountHolding { name: string; value: number; costBasis?: number | null }
export interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: AccountHolding[] }
// Cost-basis fields:
//  - costBasis: the resolved basis (null when none available). May be PARTIAL.
//  - costBasisCoveredValue: market value of the portion the basis covers, so the
//    client can compute an honest gain on just that portion.
//  - costBasisComplete: false when the basis covers only some lots.
//  - costBasisSource: where the basis came from, in descending accuracy —
//    'manual' (user-entered) > 'imported' (1099-B/statement) > 'reported'
//    (feed cost_basis or purchase_price×shares) > 'estimated' (shares × price on
//    the acquisition date). null when no basis is available.
export type CostBasisSource = 'manual' | 'imported' | 'reported' | 'estimated';
// How well KevFin can see inside a holding, best first:
//  - 'full': every holding (fund company list, N-PORT filing, or a direct stock)
//  - 'top': only the fund's top holdings, plus its stock/bond/cash split if known
//  - 'split': only the stock/bond/cash split (no holdings at all)
//  - 'name': classified from its name alone (or nothing at all)
// The client offers "describe what this tracks" for the last two.
export type LookThroughQuality = 'full' | 'top' | 'split' | 'name';
export interface HoldingRow {
  symbol: string; name: string; value: number;
  costBasis: number | null; costBasisCoveredValue: number; costBasisComplete: boolean; costBasisSource: CostBasisSource | null;
  pct: number; assetClass: string; overridden: boolean; accounts: AccountHolding[];
  // The user's own description of what the holding tracks (holdingProfiles.ts),
  // and how much KevFin could see inside it. Absent for homes / manual assets.
  // profileId is the key the description is saved under (the feed's own
  // ticker or name — not a stand-in ticker the row may be shown under).
  profileId?: string; profile?: MixPart[] | null; lookThrough?: LookThroughQuality;
}
// Credit quality of the bonds inside the user's funds, weighted by how many
// bond dollars each fund holds. `coverage`: share of bond dollars Yahoo rated.
export interface BondSummary {
  value: number; coverage: number; byRating: Slice[]; govShare: number | null; avgDuration: number | null; avgMaturity: number | null;
  // Where those bond dollars sit: each position that holds bonds, largest
  // first, with its bond dollars split across the accounts holding it.
  // Optional: results stored before this field existed lack it.
  heldIn?: BondHolding[];
}
export interface BondHolding { symbol: string; name: string; value: number; accounts: { name: string; value: number }[] }

// One position's bond dollars, spread over the accounts that hold it in
// proportion to each account's share of the position (as addStock does for
// stocks). Pure so the bond card's "Held in" list can be unit-tested.
export function bondHolding(symbol: string, name: string, bondValue: number, positionValue: number, accounts: Map<string, { value: number }>): BondHolding {
  const split = positionValue > 0
    ? [...accounts.entries()].map(([a, v]) => ({ name: a, value: bondValue * (v.value / positionValue) })).filter(a => a.value > 0)
    : [];
  return { symbol, name, value: bondValue, accounts: split.sort((x, y) => y.value - x.value) };
}
export function sortBondHoldings(list: BondHolding[]): BondHolding[] {
  return [...list].sort((a, b) => b.value - a.value);
}
export interface RealEstateLot { id: number; address: string; equity: number; excluded: boolean }
export interface Allocation {
  total: number;
  holdings: HoldingRow[];
  bySector: Slice[];
  byStock: StockExposure[];
  byCountry: Slice[];
  byAssetClass: Slice[];
  assetClasses: string[]; // the buckets a holding can be assigned to (for the picker)
  realEstate: RealEstateLot[]; // homes (equity), for the include/exclude control
  // Set when some fund lacks full holdings AND we know why (no SEC contact
  // email configured, or SEC is refusing us) — the client offers a fix inline.
  lookThrough?: LookThroughIssue;
  bonds?: BondSummary; // only when the portfolio holds bond funds
}

// Combine "did any fund lack deep holdings" with the EDGAR module's own view of
// what's wrong. Pure so it can be unit-tested without a database.
export function lookThroughNotice(anyFundMissingDeep: boolean, issue: LookThroughIssue | null): LookThroughIssue | undefined {
  return anyFundMissingDeep && issue ? issue : undefined;
}

// The broad (Schwab-style) buckets used by the asset-allocation view and offered
// in the manual-classification picker.
export const ASSET_CLASSES = [
  'Domestic Stock', 'Foreign Stock', 'Bonds', 'Short Term', 'Real Estate',
  'Private Equity', 'Alternatives', 'Commodities', 'Crypto', 'Options', 'Uncategorized',
] as const;

// Stable id for a holding's override row: the display symbol, or the name when
// the holding carries no ticker. Must match what the client sends.
export function holdingId(symbol: string, name: string): string {
  return symbol && symbol.trim() ? symbol.trim() : name.trim();
}

// Refinements that the broad bond/commodity check doesn't catch: option
// contracts (e.g. "SPXW260821P160") and real-estate / REIT funds.
function extraClass(symbol: string, name: string): 'Options' | 'Real Estate' | null {
  const s = `${symbol} ${name}`.toLowerCase();
  if (/\d{6}[cp]\d|\bcall\b|\bput\b|\boption(s)?\b/.test(s)) return 'Options';
  if (/\breit(s)?\b|real estate|\bvnq\b|\bvnqi\b|\bschh\b|\biyr\b|\bxlre\b|\brwr\b|\bicf\b/.test(s)) return 'Real Estate';
  return null;
}

// Default broad asset class for a manually-tracked asset, inferred from its name
// (the user can still override it via the same classify picker as holdings).
function classifyManual(name: string): string {
  const extra = extraClass('', name);       // Real Estate / Options
  if (extra) return extra;
  if (isCryptoAsset('', name, false)) return 'Crypto';
  const ne = broadNonEquity('', name);      // Bonds / Short Term / Commodities
  if (ne) return ne;
  if (/private equity|\bpe\b|venture|\bvc\b|pre.?ipo|\bspv\b|\blp\b|partnership|angel|startup|equity stake/i.test(name)) return 'Private Equity';
  return 'Alternatives';
}

// Detect crypto assets by account context or symbol/name.
function isCryptoAsset(symbol: string, name: string, accountIsCrypto: boolean): boolean {
  if (accountIsCrypto) return true;
  const s = `${symbol} ${name}`.toLowerCase();
  return /\bbtc\b|bitcoin|\beth\b|ethereum|\bdoge\b|dogecoin|\bsol\b|solana|\bada\b|cardano|\bxrp\b|\bltc\b|litecoin|\bavax\b|\bmatic\b|\blink\b|\bdot\b|\bshib\b|\bbch\b|\busdc\b|\busdt\b|crypto|grayscale|\bgdlc\b|\bgbtc\b|digital large/.test(s);
}

// Bucket holdings that carry no equity sector data (gold, bonds, cash).
export function fallbackSector(symbol: string, name: string, isCrypto: boolean): string {
  if (isCrypto) return 'Crypto';
  const s = `${symbol} ${name}`.toLowerCase();
  // gold/silver/oil/treasury need word boundaries so issuer names ("Goldman
  // Sachs", "Treasury Wine Estates") aren't mistaken for commodity/bond funds.
  if (/\bgold\b|\bsilver\b|commodit|\bmetal|\bgld\b|\biau\b|\bslv\b|\bsgol\b|\bgldm\b|\bpdbc\b|\bdbc\b|\boil\b|natural gas/.test(s))
    return 'Commodities / Alternatives';
  if (/bond|\btreasury\b|aggregate|\bagg\b|\bbnd\b|fixed income|\btips\b|municipal|\bgovt\b|\bbndx\b|money market|\bspaxx\b|cash reserves/.test(s))
    return 'Bonds';
  return 'Cash / Other';
}

// Broad non-equity asset class from a fund's symbol/name, for the Schwab-style
// allocation buckets. Returns null for anything that looks like equity.
export function broadNonEquity(symbol: string, name: string): 'Bonds' | 'Short Term' | 'Commodities' | null {
  const s = `${symbol} ${name}`.toLowerCase();
  if (/money market|cash reserves|\bspaxx\b|\bfdrxx\b|\bvmfxx\b|\bswvxx\b|\bfzfxx\b|\bfcash\b|t.?bill|treasury bill|ultra.?short/.test(s)) return 'Short Term';
  if (/\bbonds?\b|\btreasury\b|aggregate|\bagg\b|\bbnd\b|\bbndx\b|fixed income|\btips\b|municipal|\bgovt\b|\bvgsh\b|\bvcsh\b|\bvcit\b|\bvgit\b|\blqd\b|\bhyg\b|\bjnk\b/.test(s)) return 'Bonds';
  if (/\bgold\b|\bsilver\b|commodit|\bmetal\b|\bgld\b|\biau\b|\bslv\b|\bsgol\b|\bgldm\b|\bpdbc\b|\bdbc\b|crude|\boil\b|natural gas/.test(s)) return 'Commodities';
  return null;
}

// Accumulate value into a nested name -> (label -> value) map.
function add(map: Map<string, Map<string, number>>, name: string, label: string, value: number) {
  const inner = map.get(name) ?? new Map<string, number>();
  inner.set(label, (inner.get(label) ?? 0) + value);
  map.set(name, inner);
}

// Name heuristics for funds with no constituent-level country data.
export function looksInternational(symbol: string, name: string): boolean {
  return /\b(international|intl|ex.?us|world|global|emerging|developed|eafe|pacific|europe|asia|foreign)\b/i.test(`${symbol} ${name}`);
}
// Domestic only when the name gives no sign of a foreign or mixed mandate
// (target-date / allocation funds blend US and foreign, so stay unattributed).
export function looksDomesticEquityFund(symbol: string, name: string): boolean {
  return !looksInternational(symbol, name) && !/\b(target|retirement|allocation|balanced|lifestrategy|lifecycle|20[2-6]\d)\b/i.test(name);
}

// Asset class for a fund's non-stock rows.
const KIND_CLASS: Record<NonNullable<Constituent['kind']>, string> = { bond: 'Bonds', cash: 'Short Term', other: 'Alternatives' };

// A fund's stock / bond / cash / other split: from a full holdings list's
// non-stock rows when it has any, else from Yahoo's split, else unknown (null).
export function nonStockSplit(deepHoldings: Constituent[] | null, comp: FundComposition | null): FundComposition | null {
  if (deepHoldings?.some(h => h.kind)) {
    const sum = (k: string) => deepHoldings.filter(h => h.kind === k).reduce((s, h) => s + h.percent, 0);
    const bond = sum('bond'), cash = sum('cash'), other = sum('other');
    return { stock: Math.max(0, 1 - bond - cash - other), bond, cash, other };
  }
  return comp;
}

function addNonStock(map: Map<string, Map<string, number>>, split: FundComposition, label: string, value: number, names: { bond: string; cash: string; other: string }) {
  if (split.bond > 0) add(map, names.bond, label, value * split.bond);
  if (split.cash > 0) add(map, names.cash, label, value * split.cash);
  if (split.other > 0) add(map, names.other, label, value * split.other);
}

/**
 * A user-described mix ("VTI 60, BND 40") as one synthetic fund: its holdings,
 * sector weights, stock/bond/cash split and bond quality are its parts'
 * (already fetched into `metas` / `deep`) weighted by the mix. Pure.
 */
export function composeMix(mix: MixPart[], metas: Map<string, SecurityMeta>, deep: Map<string, Constituent[] | null>): { meta: SecurityMeta; holdings: Constituent[] | null } {
  const list: Constituent[] = [];
  const sectorAbs = new Map<string, number>();
  const comp: FundComposition = { stock: 0, bond: 0, cash: 0, other: 0 };
  const ratings = new Map<string, number>();
  let ratedBond = 0, gov = 0, govBase = 0, dur = 0, durBase = 0;
  for (const { ticker, weight: w } of mix) {
    const m = metas.get(ticker);
    const d = deep.get(ticker) ?? null;
    if (m?.quoteType === 'EQUITY') {
      list.push({ symbol: ticker, name: ticker, percent: w, country: m.country ?? undefined });
      if (m.sector) sectorAbs.set(m.sector, (sectorAbs.get(m.sector) ?? 0) + w);
      comp.stock += w;
      continue;
    }
    const split = nonStockSplit(d, m?.composition ?? null) ?? { stock: 1, bond: 0, cash: 0, other: 0 };
    comp.stock += w * split.stock; comp.bond += w * split.bond; comp.cash += w * split.cash; comp.other += w * split.other;
    for (const [sec, sw] of Object.entries(m?.sectorWeightings ?? {})) sectorAbs.set(sec, (sectorAbs.get(sec) ?? 0) + w * split.stock * sw);
    if (d?.length) list.push(...d.map(c => ({ ...c, percent: c.percent * w })));
    else {
      list.push({ symbol: ticker, name: ticker, percent: w * split.stock, fund: true });
      if (split.bond > 0) list.push(lump('bond', w * split.bond));
      if (split.cash > 0) list.push(lump('cash', w * split.cash));
      if (split.other > 0) list.push(lump('other', w * split.other));
    }
    const b = m?.bonds;
    if (b && split.bond > 0) {
      const bw = w * split.bond;
      if (Object.keys(b.ratings).length) { ratedBond += bw; for (const [k, v] of Object.entries(b.ratings)) ratings.set(k, (ratings.get(k) ?? 0) + bw * v); }
      if (b.govShare != null) { gov += bw * b.govShare; govBase += bw; }
      if (b.duration != null) { dur += bw * b.duration; durBase += bw; }
    }
  }
  const sectorWeightings = comp.stock > 0 && sectorAbs.size
    ? Object.fromEntries([...sectorAbs].map(([k, v]) => [k, v / comp.stock])) : null;
  const meta: SecurityMeta = {
    quoteType: 'MUTUALFUND', sector: null, country: null, sectorWeightings, holdings: null, family: null,
    composition: comp,
    bonds: comp.bond > 0 && (ratedBond > 0 || durBase > 0) ? {
      ratings: Object.fromEntries([...ratings].map(([k, v]) => [k, v / (ratedBond || 1)])),
      govShare: govBase ? gov / govBase : null, duration: durBase ? dur / durBase : null, maturity: null,
    } : null,
  };
  return { meta, holdings: list.length ? mergeConstituents(list) : null };
}

const RATING_ORDER = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'Below B', 'Not rated'];

function toSlices(map: Map<string, Map<string, number>>, total: number, withCode = false): Slice[] {
  return [...map.entries()]
    .map(([name, inner]) => {
      const value = [...inner.values()].reduce((a, b) => a + b, 0);
      const contributors = [...inner.entries()]
        .map(([label, v]) => ({ label, value: v }))
        .sort((a, b) => b.value - a.value);
      const slice: Slice = { name, value, pct: total ? value / total : 0, contributors };
      const code = withCode ? countryCode(name) : null;
      if (code) slice.code = code;
      return slice;
    })
    .sort((a, b) => b.value - a.value);
}

export async function getAllocation(opts: { estimate?: boolean } = {}): Promise<Allocation> {
  const db = getDb();
  const accts = db.prepare('SELECT id, name, category, hidden FROM accounts').all() as {
    id: string; name: string; category: string; hidden: number;
  }[];
  const brokerage = new Map(accts.filter(a => a.category === 'brokerage' && !a.hidden).map(a => [a.id, a.name]));

  const holdingsByAccount = await fetchHoldings();
  // The user's own descriptions of untickered / unknown holdings (a 401(k)
  // trust = "VTI 60, BND 40"), keyed by the holding as the feed reports it:
  // its ticker, or its name when it has none.
  const profiles = getHoldingProfiles();

  type AggAccount = { value: number; costBasis: number | null };
  type EstLot = { shares: number; acquired: string };
  const agg = new Map<string, { profileId: string; displaySymbol: string; metaSymbol: string; name: string; value: number; costBasis: number; coveredValue: number; lotsWithBasis: number; lotsTotal: number; estLots: EstLot[]; isCrypto: boolean; accounts: Map<string, AggAccount> }>();
  for (const [accId, holdings] of holdingsByAccount) {
    if (!brokerage.has(accId)) continue;
    const accountName = brokerage.get(accId) ?? 'Unknown';
    const accountIsCrypto = /crypto/i.test(accountName);
    for (const h of holdings) {
      const profileId = holdingId(h.symbol, h.description);
      const metaSymbol = effectiveChain(h.symbol, h.description)[0] ?? '';
      // An untickered holding is shown under its stand-in ticker (ITDD for a 529
      // portfolio) — unless the user described it, in which case it keeps its
      // own name and isn't merged with a real holding of that ticker.
      const displaySymbol = h.symbol || (profiles.has(profileId) ? '' : metaSymbol) || '';
      const key = displaySymbol || h.description || 'Unknown';
      const isCrypto = isCryptoAsset(h.symbol, h.description, accountIsCrypto);
      const row = agg.get(key) ?? { profileId, displaySymbol, metaSymbol, name: h.description || displaySymbol || key, value: 0, costBasis: 0, coveredValue: 0, lotsWithBasis: 0, lotsTotal: 0, estLots: [], isCrypto, accounts: new Map<string, AggAccount>() };
      row.value += h.marketValue;
      row.lotsTotal++;
      // Sum the basis we DO have (partial is fine); coveredValue tracks the
      // market value of just those lots so gain can be honest on the covered
      // portion rather than charging the whole position against a partial basis.
      if (h.costBasis != null) { row.costBasis += h.costBasis; row.coveredValue += h.marketValue; row.lotsWithBasis++; }
      // Capture share count + acquisition date for a last-resort price estimate.
      if (h.shares != null && h.acquired) row.estLots.push({ shares: h.shares, acquired: h.acquired });
      const acc = row.accounts.get(accountName) ?? { value: 0, costBasis: null };
      acc.value += h.marketValue;
      if (h.costBasis != null) acc.costBasis = (acc.costBasis ?? 0) + h.costBasis;
      row.accounts.set(accountName, acc);
      agg.set(key, row);
    }
  }

  const rows = [...agg.values()];
  const total = rows.reduce((s, r) => s + r.value, 0);

  // Manual asset-class overrides, keyed by holdingId (symbol or name).
  const overrides = new Map(
    (db.prepare('SELECT symbol, asset_class FROM asset_class_overrides').all() as { symbol: string; asset_class: string }[])
      .map(o => [o.symbol, o.asset_class] as const),
  );

  // Manual cost-basis overrides, keyed by the same holdingId.
  const cbOverrides = new Map(
    (db.prepare('SELECT symbol, cost_basis FROM cost_basis_overrides').all() as { symbol: string; cost_basis: number }[])
      .map(o => [o.symbol, o.cost_basis] as const),
  );
  // Cost basis imported from a 1099-B / statement (lower precedence than manual).
  const importedCb = new Map(
    (db.prepare('SELECT symbol, cost_basis FROM imported_cost_basis').all() as { symbol: string; cost_basis: number }[])
      .map(o => [o.symbol, o.cost_basis] as const),
  );

  // Last-resort ESTIMATED basis (opt-in): shares × historical close on each
  // lot's acquisition date. Only for positions that have no manual, imported, or
  // feed-reported basis and where every lot carries shares + a date — so the
  // estimate spans the whole position. Best-effort: any unpriceable lot → skip.
  const estimated = new Map<string, number>();
  if (opts.estimate) {
    const today = new Date().toISOString().slice(0, 10);
    const candidates = rows.filter(r => {
      const id = holdingId(r.displaySymbol, r.name);
      return !r.isCrypto && r.lotsWithBasis === 0 && !cbOverrides.has(id) && !importedCb.has(id)
        && r.estLots.length > 0 && r.estLots.length === r.lotsTotal;
    });
    await Promise.all(candidates.map(async r => {
      const id = holdingId(r.displaySymbol, r.name);
      const from = r.estLots.map(l => l.acquired).sort()[0];
      for (const ticker of effectiveChain(r.displaySymbol, r.name)) {
        const series = await fetchDailyCloses(ticker, from, today).catch(() => []);
        if (!series.length) continue;
        let basis = 0, ok = true;
        for (const lot of r.estLots) {
          const px = closeAsOf(series, lot.acquired);
          if (px == null || px <= 0) { ok = false; break; }
          basis += lot.shares * px;
        }
        if (ok && basis > 0) { estimated.set(id, basis); return; }
      }
    }));
  }

  // --- Real estate (home equity) + manually-tracked assets, folded into the
  // overall allocation so it reflects the whole portfolio, not just brokerage.
  // The primary residence (or any home) can be excluded via opts. ---
  // Exclusion is stored per-property (durable), not per-browser.
  const realEstate: RealEstateLot[] = (db
    .prepare('SELECT id, address, zestimate, mortgage_balance, excluded_from_allocation FROM properties ORDER BY address')
    .all() as { id: number; address: string; zestimate: number | null; mortgage_balance: number; excluded_from_allocation: number }[])
    .map(p => ({
      id: p.id, address: p.address,
      equity: Math.max(0, (p.zestimate ?? 0) - (p.mortgage_balance ?? 0)),
      excluded: !!p.excluded_from_allocation,
    }));
  const includedProps = realEstate.filter(p => !p.excluded && p.equity > 0);

  const manualAssets = (db.prepare('SELECT id, name, value FROM manual_assets').all() as { id: number; name: string; value: number }[])
    .filter(m => m.value > 0);

  const extrasValue =
    includedProps.reduce((s, p) => s + p.equity, 0) +
    manualAssets.reduce((s, m) => s + m.value, 0);
  // Grand total = brokerage holdings + included home equity + manual assets.
  const grandTotal = total + extrasValue;

  // A one-ticker description already reached metaSymbol through
  // effectiveChain(); a mix gets a composite key whose meta and holdings are
  // built below from its parts.
  const mixes = new Map<string, MixPart[]>();
  for (const r of rows) {
    const mix = profiles.get(r.profileId);
    if (mix && mix.length > 1 && !r.isCrypto) { r.metaSymbol = `mix:${r.profileId}`; mixes.set(r.metaSymbol, mix); }
  }

  const distinctSymbols = [...new Set([
    ...rows.filter(r => r.metaSymbol && !r.isCrypto && !mixes.has(r.metaSymbol)).map(r => r.metaSymbol),
    ...[...mixes.values()].flatMap(m => m.map(p => p.ticker)),
  ])];
  const metas = new Map<string, SecurityMeta>();
  const deep = new Map<string, Constituent[] | null>(); // full issuer holdings where reachable
  await Promise.all(distinctSymbols.map(async s => {
    const [m, d] = await Promise.all([fetchSecurityMeta(s), fetchDeepConstituents(s).catch(() => null)]);
    metas.set(s, m);
    deep.set(s, d);
  }));
  for (const [key, mix] of mixes) {
    const { meta, holdings } = composeMix(mix, metas, deep);
    metas.set(key, meta);
    deep.set(key, holdings);
  }

  // Stocks Yahoo knows but can't place (no sector / country): SEC's company
  // record gives an industry code and headquarters. Only for direct holdings.
  const secProfiles = new Map<string, Awaited<ReturnType<typeof fetchSecCompanyProfile>>>();
  await Promise.all([...metas.entries()]
    .filter(([sym, m]) => m.quoteType === 'EQUITY' && (!m.sector || !m.country) && !sym.startsWith('mix:'))
    .map(async ([sym]) => secProfiles.set(sym, await fetchSecCompanyProfile(sym).catch(() => null))));
  for (const [sym, p] of secProfiles) {
    const m = metas.get(sym);
    if (!m || !p) continue;
    metas.set(sym, { ...m, sector: m.sector ?? p.sector, country: m.country ?? p.country });
  }

  // One stock, many sources: Vanguard reports TSMC as "2330", an N-PORT filing
  // as "TAIWAN SEMICONDUCTOR MANUFACTURING" — both carry its ISIN. Key every
  // constituent by the first real ticker seen for its ISIN so it merges.
  const tickerByIsin = new Map<string, { symbol: string; name: string }>();
  for (const list of deep.values()) for (const c of list ?? []) {
    if (c.isin && !c.named && !c.kind && !tickerByIsin.has(c.isin)) tickerByIsin.set(c.isin, { symbol: c.symbol, name: c.name });
  }
  const canonical = (c: Constituent) => (c.isin && c.named && tickerByIsin.get(c.isin)) || c;

  const sectorMap = new Map<string, Map<string, number>>();  // sector -> (holding -> value)
  const countryMap = new Map<string, Map<string, number>>(); // country -> (holding -> value)
  const assetMap = new Map<string, Map<string, number>>();   // broad asset class -> (holding -> value)
  const stockMap = new Map<string, { name: string; sources: Map<string, number>; accounts: Map<string, number> }>();
  const holdings: HoldingRow[] = [];
  // Bond dollars by rating (weighted by each fund's bond holdings).
  const bondAgg = { value: 0, rated: 0, ratings: new Map<string, number>(), gov: 0, govBase: 0, dur: 0, durBase: 0, mat: 0, matBase: 0, heldIn: [] as BondHolding[] };

  // Add stock exposure of `value` coming from holding `row`, distributing it
  // across the accounts that hold that holding (proportional to their share).
  const addStock = (sym: string, name: string, source: string, value: number, row: { accounts: Map<string, AggAccount>; value: number }) => {
    const e = stockMap.get(sym) ?? { name, sources: new Map<string, number>(), accounts: new Map<string, number>() };
    e.sources.set(source, (e.sources.get(source) ?? 0) + value);
    if (row.value > 0) for (const [a, v] of row.accounts) e.accounts.set(a, (e.accounts.get(a) ?? 0) + value * (v.value / row.value));
    stockMap.set(sym, e);
  };

  for (const r of rows) {
    const meta = r.metaSymbol ? metas.get(r.metaSymbol) : undefined;
    const id = holdingId(r.displaySymbol, r.name);
    // Contributor label in every breakdown (a described untickered holding has no symbol).
    const label = r.displaySymbol || r.name;
    const override = overrides.get(id);
    // Resolve cost basis in descending order of accuracy: manual override →
    // imported (1099-B) → feed-reported (may be partial) → estimated.
    let costBasis: number | null, coveredValue: number, complete: boolean, source: CostBasisSource | null;
    const manualOv = cbOverrides.get(id), importedOv = importedCb.get(id), estOv = estimated.get(id);
    if (manualOv != null) { costBasis = manualOv; coveredValue = r.value; complete = true; source = 'manual'; }
    else if (importedOv != null) { costBasis = importedOv; coveredValue = r.value; complete = true; source = 'imported'; }
    else if (r.lotsWithBasis > 0) { costBasis = r.costBasis; coveredValue = r.coveredValue; complete = r.lotsWithBasis === r.lotsTotal; source = 'reported'; }
    else if (estOv != null) { costBasis = estOv; coveredValue = r.value; complete = true; source = 'estimated'; }
    else { costBasis = null; coveredValue = 0; complete = true; source = null; }
    const deepHoldings = r.metaSymbol ? deep.get(r.metaSymbol) ?? null : null;
    const comp = meta?.composition ?? null;
    // assetClass is finalized in the broad asset-class block below.
    const holdingRow: HoldingRow = {
      symbol: r.displaySymbol, name: r.name, value: r.value,
      costBasis, costBasisCoveredValue: coveredValue, costBasisComplete: complete, costBasisSource: source,
      pct: grandTotal ? r.value / grandTotal : 0,
      assetClass: 'Uncategorized', overridden: !!override,
      accounts: [...r.accounts.entries()].map(([name, a]) => ({ name, value: a.value, costBasis: a.costBasis })).sort((x, y) => y.value - x.value),
      profileId: r.profileId, profile: profiles.get(r.profileId) ?? null,
      lookThrough: r.isCrypto || meta?.quoteType === 'EQUITY' || deepHoldings?.length ? 'full'
        : meta?.holdings?.length ? 'top' : comp || meta?.sectorWeightings ? 'split' : 'name',
    };
    holdings.push(holdingRow);

    // The fund's non-stock part: from a full holdings list's bond/cash/other
    // rows when there is one, else from its stock/bond/cash split.
    const split = nonStockSplit(deepHoldings, comp);
    // The user's own description beats any guess from the holding's name.
    const described = !!holdingRow.profile?.length;
    // Bond funds (by split, or by name when nothing is known) are non-equity
    // throughout — not a "diversified" stock remainder.
    const nonEquityFund = !r.isCrypto && meta?.quoteType !== 'EQUITY' && (split
      ? split.stock < 0.05
      : !deepHoldings && !meta?.sectorWeightings && !meta?.sector &&
        ['Bonds', 'Commodities / Alternatives'].includes(fallbackSector(r.displaySymbol, r.name, false)));
    // A bond fund's split is all there is to know about it for these views.
    if (holdingRow.lookThrough === 'split' && nonEquityFund) holdingRow.lookThrough = 'full';

    // --- Sector look-through ---
    // Yahoo's fund sector weights describe the STOCK part only (they sum to 1
    // even for a 60/40 fund), so they're scaled by the fund's stock share and
    // the rest goes to Bonds / Cash / Commodities.
    if (r.isCrypto) {
      add(sectorMap, 'Crypto', label, r.value);
    } else if (nonEquityFund) {
      add(sectorMap, fallbackSector(r.displaySymbol, r.name, false), label, r.value);
    } else if (meta?.sectorWeightings) {
      const stockShare = split ? split.stock : 1;
      for (const [sector, w] of Object.entries(meta.sectorWeightings)) add(sectorMap, sector, label, r.value * stockShare * w);
      if (split) addNonStock(sectorMap, split, label, r.value, { bond: 'Bonds', cash: 'Cash / Other', other: 'Commodities / Alternatives' });
    } else if (meta?.sector) {
      add(sectorMap, meta.sector, label, r.value);
    } else {
      add(sectorMap, fallbackSector(r.displaySymbol, r.name, r.isCrypto), label, r.value);
    }

    // --- Stock look-through: full holdings if reachable, else Yahoo top-10 ---
    if (r.isCrypto) {
      addStock(r.displaySymbol || 'Crypto', r.name || 'Crypto', 'Crypto holding', r.value, r);
    } else if (nonEquityFund) {
      addStock('— non-equity —', 'Bonds / commodities / cash', label, r.value, r);
    } else if (meta?.quoteType === 'EQUITY' && !deepHoldings) {
      addStock(r.displaySymbol, r.name, 'Direct holding', r.value, r);
    } else if (deepHoldings?.length) {
      let covered = 0, nonEquity = 0;
      for (const h of deepHoldings) {
        if (h.kind) { nonEquity += h.percent; continue; }
        const c = canonical(h);
        addStock(c.symbol, c.name, label, r.value * h.percent, r);
        covered += h.percent;
      }
      if (nonEquity > 0) addStock('— non-equity —', 'Bonds / commodities / cash', label, r.value * nonEquity, r);
      const remainder = r.value * Math.max(0, 1 - covered - nonEquity);
      if (remainder > 0) addStock('— diversified —', 'Beyond reported holdings', label, remainder, r);
    } else if (meta?.holdings?.length) {
      let covered = 0;
      for (const h of meta.holdings) {
        addStock(h.symbol, h.name, label, r.value * h.percent, r);
        covered += h.percent;
      }
      // With a known split, only the stock part beyond the top holdings is
      // "diversified"; the bond/cash part is non-equity.
      const stockShare = split ? split.stock : 1;
      const remainder = r.value * Math.max(0, stockShare - covered);
      if (remainder > 0) addStock('— diversified —', 'Beyond reported top holdings', label, remainder, r);
      if (split && split.stock < 1) addStock('— non-equity —', 'Bonds / commodities / cash', label, r.value * (1 - split.stock), r);
    } else if (split && split.stock > 0) {
      addStock('— diversified —', 'Fund (no holdings list)', label, r.value * split.stock, r);
      if (split.stock < 1) addStock('— non-equity —', 'Bonds / commodities / cash', label, r.value * (1 - split.stock), r);
    } else {
      addStock('— non-equity —', 'Bonds / commodities / cash', label, r.value, r);
    }

    // --- Country / region look-through ---
    // Funds use their constituents' countries (remainder distributed
    // proportionally); direct stocks use issuer domicile.
    if (r.isCrypto) {
      add(countryMap, 'Crypto', label, r.value);
    } else if (nonEquityFund) {
      add(countryMap, 'Bonds / Commodities / Cash', label, r.value);
    } else if (deepHoldings?.length) {
      const covered = deepHoldings.reduce((s, h) => s + h.percent, 0) || 1;
      for (const h of deepHoldings) {
        add(countryMap, canonicalCountryName(h.country ?? 'Other'), label, r.value * (h.percent / covered));
      }
    } else if (meta?.quoteType === 'EQUITY') {
      add(countryMap, canonicalCountryName(meta.country ?? 'United States'), label, r.value);
    } else if (meta?.holdings?.length || meta?.sectorWeightings || split) {
      // No constituent countries (no EDGAR / fund-company source reachable):
      // fall back on the same name heuristic the asset-class split uses.
      // Domestic-looking equity funds count as United States rather than
      // vanishing into an unmappable "International / Other" lump that swamps
      // the world map. The bond/cash part (if known) is listed apart.
      const stockShare = split ? split.stock : 1;
      add(countryMap, looksDomesticEquityFund(r.displaySymbol, r.name) ? 'United States' : 'International / Other', label, r.value * stockShare);
      if (stockShare < 1) add(countryMap, 'Bonds / Commodities / Cash', label, r.value * (1 - stockShare));
    } else {
      add(countryMap, 'Other', label, r.value);
    }

    // --- Bond credit quality (only funds Yahoo rates) ---
    if (!r.isCrypto && meta?.bonds && split) {
      const bondValue = r.value * split.bond;
      if (bondValue > 0) {
        bondAgg.value += bondValue;
        bondAgg.heldIn.push(bondHolding(r.displaySymbol, r.name, bondValue, r.value, r.accounts));
        const rated = Object.entries(meta.bonds.ratings);
        if (rated.length) {
          bondAgg.rated += bondValue;
          for (const [label, w] of rated) bondAgg.ratings.set(label, (bondAgg.ratings.get(label) ?? 0) + bondValue * w);
        }
        if (meta.bonds.govShare != null) { bondAgg.gov += bondValue * meta.bonds.govShare; bondAgg.govBase += bondValue; }
        if (meta.bonds.duration != null) { bondAgg.dur += bondValue * meta.bonds.duration; bondAgg.durBase += bondValue; }
        if (meta.bonds.maturity != null) { bondAgg.mat += bondValue * meta.bonds.maturity; bondAgg.matBase += bondValue; }
      }
    } else if (!r.isCrypto && split && split.bond > 0) {
      bondAgg.value += r.value * split.bond; // bonds we can't rate still count toward coverage
      bondAgg.heldIn.push(bondHolding(r.displaySymbol, r.name, r.value * split.bond, r.value, r.accounts));
    }

    // --- Broad asset-class look-through (Schwab-style buckets) ---
    // A manual override (if any) wins and forces the whole position into one
    // bucket. Otherwise: bond/commodity/cash funds are caught by name, options
    // and REITs by pattern, and equity funds split Domestic vs Foreign by their
    // constituents' countries, with any bond / cash / other part from the
    // fund's own breakdown. `primaryClass` is the single bucket shown for the
    // holding in the positions table (the dominant one for split funds).
    const ne = broadNonEquity(r.displaySymbol, r.name);
    const extra = extraClass(r.displaySymbol, r.name);
    let primaryClass: string;
    const addSplit = (parts: Record<string, number>) => {
      let best = '', bestV = -1;
      for (const [cls, v] of Object.entries(parts)) {
        if (v <= r.value * 0.001) continue; // a 0.1% sliver isn't worth its own slice
        add(assetMap, cls, label, v);
        if (v > bestV) { best = cls; bestV = v; }
      }
      return best || 'Uncategorized';
    };
    if (override) {
      add(assetMap, override, label, r.value);
      primaryClass = override;
    } else if (r.isCrypto) {
      add(assetMap, 'Crypto', label, r.value);
      primaryClass = 'Crypto';
    } else if (extra && !described) {
      add(assetMap, extra, label, r.value);
      primaryClass = extra;
    } else if (ne && !described && meta?.quoteType !== 'EQUITY') {
      // Name patterns only classify funds — a single stock named e.g. "Treasury
      // Wine Estates" or "Goldman Sachs" falls through to the equity branches.
      add(assetMap, ne, label, r.value);
      primaryClass = ne;
    } else if (deepHoldings?.length) {
      const covered = deepHoldings.reduce((s, h) => s + h.percent, 0) || 1;
      // Non-stock rows carry `kind` (older cached ones only the pseudo-country
      // 'Bonds / Commodities / Cash', which means bonds).
      const parts: Record<string, number> = {};
      const put = (cls: string, v: number) => { parts[cls] = (parts[cls] ?? 0) + v; };
      for (const h of deepHoldings) {
        const v = r.value * (h.percent / covered);
        const c = h.country ?? 'United States';
        if (h.kind) put(KIND_CLASS[h.kind], v);
        else if (c === 'Bonds / Commodities / Cash') put('Bonds', v);
        else if (c === 'United States') put('Domestic Stock', v);
        else if (h.fund && !h.country) put(looksInternational(h.symbol, h.name) ? 'Foreign Stock' : 'Domestic Stock', v);
        else put('Foreign Stock', v);
      }
      primaryClass = addSplit(parts);
    } else if (meta?.quoteType === 'EQUITY') {
      primaryClass = (meta.country ?? 'United States') === 'United States' ? 'Domestic Stock' : 'Foreign Stock';
      add(assetMap, primaryClass, label, r.value);
    } else if (meta?.holdings?.length || meta?.sectorWeightings || split) {
      const stockShare = split ? split.stock : 1;
      primaryClass = addSplit({
        [looksInternational(r.displaySymbol, r.name) ? 'Foreign Stock' : 'Domestic Stock']: r.value * stockShare,
        ...(split ? { Bonds: r.value * split.bond, 'Short Term': r.value * split.cash, Alternatives: r.value * split.other } : {}),
      });
    } else {
      add(assetMap, 'Uncategorized', label, r.value);
      primaryClass = 'Uncategorized';
    }
    holdingRow.assetClass = primaryClass;
  }

  // Properties → Real Estate (excluded homes already dropped). They show as
  // positions (home equity) so they appear when the Real Estate class is
  // selected; overridable via the same picker, keyed by address.
  for (const p of includedProps) {
    const id = holdingId('', p.address);
    const override = overrides.get(id);
    const cls = override ?? 'Real Estate';
    add(assetMap, cls, p.address, p.equity);
    // No cost basis for real estate: the listed value is equity (which also moves
    // as the mortgage is paid down), so equity − purchase price isn't a clean
    // gain. Left non-editable rather than show a misleading number.
    holdings.push({
      symbol: '', name: p.address, value: p.equity,
      costBasis: null, costBasisCoveredValue: 0, costBasisComplete: true, costBasisSource: null,
      pct: grandTotal ? p.equity / grandTotal : 0,
      assetClass: cls, overridden: !!override, accounts: [],
    });
  }

  // Manual assets → classified by name (overridable via the same picker, keyed
  // by name). They appear as positions so they can be reclassified.
  for (const m of manualAssets) {
    const id = holdingId('', m.name);
    const override = overrides.get(id);
    const cls = override ?? classifyManual(m.name);
    add(assetMap, cls, m.name, m.value);
    // Manual assets carry no basis from any feed, but the user can supply one
    // (manual entry, or imported from a statement) via the same cost-basis key.
    const manualOv = cbOverrides.get(id), importedOv = importedCb.get(id);
    const mcb = manualOv ?? importedOv ?? null;
    holdings.push({
      symbol: '', name: m.name, value: m.value,
      costBasis: mcb, costBasisCoveredValue: mcb != null ? m.value : 0, costBasisComplete: true,
      costBasisSource: manualOv != null ? 'manual' : importedOv != null ? 'imported' : null,
      pct: grandTotal ? m.value / grandTotal : 0,
      assetClass: cls, overridden: !!override, accounts: [],
    });
  }

  holdings.sort((a, b) => b.value - a.value);

  const byStock: StockExposure[] = [...stockMap.entries()]
    .map(([symbol, e]) => {
      const value = [...e.sources.values()].reduce((a, b) => a + b, 0);
      const sources = [...e.sources.entries()].map(([label, v]) => ({ label, value: v })).sort((a, b) => b.value - a.value);
      const accounts = [...e.accounts.entries()].map(([name, v]) => ({ name, value: v })).sort((a, b) => b.value - a.value);
      return { symbol, name: e.name, value, pct: total ? value / total : 0, sources, accounts };
    })
    .sort((a, b) => b.value - a.value);

  // A fund (not a single stock, crypto or an obvious bond/commodity fund) that
  // came back without full holdings is what the contact-email notice is about.
  const anyFundMissingDeep = rows.some(r =>
    r.metaSymbol && !r.isCrypto && !deep.get(r.metaSymbol) && metas.get(r.metaSymbol)?.quoteType !== 'EQUITY' &&
    !broadNonEquity(r.displaySymbol, r.name));

  const bonds: BondSummary | undefined = bondAgg.value > 0 ? {
    value: bondAgg.value,
    coverage: bondAgg.rated / bondAgg.value,
    byRating: [...bondAgg.ratings.entries()]
      .map(([name, v]) => ({ name, value: v * (bondAgg.value / (bondAgg.rated || 1)), pct: bondAgg.rated ? v / bondAgg.rated : 0, contributors: [] }))
      .sort((a, b) => RATING_ORDER.indexOf(a.name) - RATING_ORDER.indexOf(b.name)),
    govShare: bondAgg.govBase ? bondAgg.gov / bondAgg.govBase : null,
    avgDuration: bondAgg.durBase ? bondAgg.dur / bondAgg.durBase : null,
    avgMaturity: bondAgg.matBase ? bondAgg.mat / bondAgg.matBase : null,
    heldIn: sortBondHoldings(bondAgg.heldIn),
  } : undefined;

  return {
    lookThrough: lookThroughNotice(anyFundMissingDeep, getLookThroughIssue()),
    ...(bonds ? { bonds } : {}),
    total: grandTotal, holdings, byStock,
    // Equity look-throughs stay relative to invested (brokerage) total so their
    // shares still sum to ~100% of the stock portfolio.
    bySector: toSlices(sectorMap, total),
    byCountry: toSlices(countryMap, total, true),
    byAssetClass: toSlices(assetMap, grandTotal),
    assetClasses: [...ASSET_CLASSES],
    realEstate,
  };
}
