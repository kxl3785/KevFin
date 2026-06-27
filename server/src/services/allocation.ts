import { getDb } from '../db/schema.js';
import { fetchHoldings } from './simplefin.js';
import { effectiveChain, fetchDailyCloses, closeAsOf } from './prices.js';
import { fetchSecurityMeta } from './yahooMeta.js';
import { fetchDeepConstituents, type Constituent } from './fundHoldings.js';

export interface Contributor { label: string; value: number }
export interface Slice { name: string; value: number; pct: number; contributors: Contributor[] }
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
export interface HoldingRow {
  symbol: string; name: string; value: number;
  costBasis: number | null; costBasisCoveredValue: number; costBasisComplete: boolean; costBasisSource: CostBasisSource | null;
  pct: number; assetClass: string; overridden: boolean; accounts: AccountHolding[];
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
function fallbackSector(symbol: string, name: string, isCrypto: boolean): string {
  if (isCrypto) return 'Crypto';
  const s = `${symbol} ${name}`.toLowerCase();
  if (/gold|silver|commodit|\bmetal|\bgld\b|\biau\b|\bslv\b|\bsgol\b|\bgldm\b|\bpdbc\b|\bdbc\b|oil|natural gas/.test(s))
    return 'Commodities / Alternatives';
  if (/bond|treasury|aggregate|\bagg\b|\bbnd\b|fixed income|\btips\b|municipal|\bgovt\b|\bbndx\b|money market|\bspaxx\b|cash reserves/.test(s))
    return 'Bonds';
  return 'Cash / Other';
}

// Broad non-equity asset class from a fund's symbol/name, for the Schwab-style
// allocation buckets. Returns null for anything that looks like equity.
function broadNonEquity(symbol: string, name: string): 'Bonds' | 'Short Term' | 'Commodities' | null {
  const s = `${symbol} ${name}`.toLowerCase();
  if (/money market|cash reserves|\bspaxx\b|\bfdrxx\b|\bvmfxx\b|\bswvxx\b|\bfzfxx\b|\bfcash\b|t.?bill|treasury bill|ultra.?short/.test(s)) return 'Short Term';
  if (/\bbonds?\b|treasury|aggregate|\bagg\b|\bbnd\b|\bbndx\b|fixed income|\btips\b|municipal|\bgovt\b|\bvgsh\b|\bvcsh\b|\bvcit\b|\bvgit\b|\blqd\b|\bhyg\b|\bjnk\b/.test(s)) return 'Bonds';
  if (/gold|silver|commodit|\bmetal\b|\bgld\b|\biau\b|\bslv\b|\bsgol\b|\bgldm\b|\bpdbc\b|\bdbc\b|crude|\boil\b|natural gas/.test(s)) return 'Commodities';
  return null;
}

// Accumulate value into a nested name -> (label -> value) map.
function add(map: Map<string, Map<string, number>>, name: string, label: string, value: number) {
  const inner = map.get(name) ?? new Map<string, number>();
  inner.set(label, (inner.get(label) ?? 0) + value);
  map.set(name, inner);
}

function toSlices(map: Map<string, Map<string, number>>, total: number): Slice[] {
  return [...map.entries()]
    .map(([name, inner]) => {
      const value = [...inner.values()].reduce((a, b) => a + b, 0);
      const contributors = [...inner.entries()]
        .map(([label, v]) => ({ label, value: v }))
        .sort((a, b) => b.value - a.value);
      return { name, value, pct: total ? value / total : 0, contributors };
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

  type AggAccount = { value: number; costBasis: number | null };
  type EstLot = { shares: number; acquired: string };
  const agg = new Map<string, { displaySymbol: string; metaSymbol: string; name: string; value: number; costBasis: number; coveredValue: number; lotsWithBasis: number; lotsTotal: number; estLots: EstLot[]; isCrypto: boolean; accounts: Map<string, AggAccount> }>();
  for (const [accId, holdings] of holdingsByAccount) {
    if (!brokerage.has(accId)) continue;
    const accountName = brokerage.get(accId) ?? 'Unknown';
    const accountIsCrypto = /crypto/i.test(accountName);
    for (const h of holdings) {
      const metaSymbol = effectiveChain(h.symbol, h.description)[0] ?? '';
      const displaySymbol = h.symbol || metaSymbol || '';
      const key = displaySymbol || h.description || 'Unknown';
      const isCrypto = isCryptoAsset(h.symbol, h.description, accountIsCrypto);
      const row = agg.get(key) ?? { displaySymbol, metaSymbol, name: h.description || displaySymbol || key, value: 0, costBasis: 0, coveredValue: 0, lotsWithBasis: 0, lotsTotal: 0, estLots: [], isCrypto, accounts: new Map<string, AggAccount>() };
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

  const distinctSymbols = [...new Set(rows.filter(r => r.metaSymbol && !r.isCrypto).map(r => r.metaSymbol))];
  const metas = new Map<string, Awaited<ReturnType<typeof fetchSecurityMeta>>>();
  const deep = new Map<string, Constituent[] | null>(); // full issuer holdings where reachable
  await Promise.all(distinctSymbols.map(async s => {
    const [m, d] = await Promise.all([fetchSecurityMeta(s), fetchDeepConstituents(s)]);
    metas.set(s, m);
    deep.set(s, d);
  }));

  const sectorMap = new Map<string, Map<string, number>>();  // sector -> (holding -> value)
  const countryMap = new Map<string, Map<string, number>>(); // country -> (holding -> value)
  const assetMap = new Map<string, Map<string, number>>();   // broad asset class -> (holding -> value)
  const stockMap = new Map<string, { name: string; sources: Map<string, number>; accounts: Map<string, number> }>();
  const holdings: HoldingRow[] = [];

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
    // assetClass is finalized in the broad asset-class block below.
    const holdingRow: HoldingRow = {
      symbol: r.displaySymbol, name: r.name, value: r.value,
      costBasis, costBasisCoveredValue: coveredValue, costBasisComplete: complete, costBasisSource: source,
      pct: grandTotal ? r.value / grandTotal : 0,
      assetClass: 'Uncategorized', overridden: !!override,
      accounts: [...r.accounts.entries()].map(([name, a]) => ({ name, value: a.value, costBasis: a.costBasis })).sort((x, y) => y.value - x.value),
    };
    holdings.push(holdingRow);

    // --- Sector look-through ---
    if (meta?.sectorWeightings && !r.isCrypto) {
      for (const [sector, w] of Object.entries(meta.sectorWeightings)) add(sectorMap, sector, r.displaySymbol, r.value * w);
    } else if (meta?.sector && !r.isCrypto) {
      add(sectorMap, meta.sector, r.displaySymbol, r.value);
    } else {
      add(sectorMap, fallbackSector(r.displaySymbol, r.name, r.isCrypto), r.displaySymbol, r.value);
    }

    // --- Stock look-through: full issuer holdings if reachable, else Yahoo top-10 ---
    const deepHoldings = r.metaSymbol ? deep.get(r.metaSymbol) : null;
    // Bond/commodity funds (no equity sector data, no deep source) → non-equity,
    // not a "diversified" stock remainder.
    const nonEquityFund = !deepHoldings && !meta?.sectorWeightings && !meta?.sector &&
      ['Bonds', 'Commodities / Alternatives'].includes(fallbackSector(r.displaySymbol, r.name, false));
    if (r.isCrypto) {
      addStock(r.displaySymbol || 'Crypto', r.name || 'Crypto', 'Crypto holding', r.value, r);
    } else if (nonEquityFund) {
      addStock('— non-equity —', 'Bonds / commodities / cash', r.displaySymbol, r.value, r);
    } else if (meta?.quoteType === 'EQUITY' && !deepHoldings) {
      addStock(r.displaySymbol, r.name, 'Direct holding', r.value, r);
    } else if (deepHoldings?.length) {
      let covered = 0;
      for (const h of deepHoldings) {
        addStock(h.symbol, h.name, r.displaySymbol, r.value * h.percent, r);
        covered += h.percent;
      }
      const remainder = r.value * Math.max(0, 1 - covered);
      if (remainder > 0) addStock('— diversified —', 'Beyond reported holdings', r.displaySymbol, remainder, r);
    } else if (meta?.holdings?.length) {
      let covered = 0;
      for (const h of meta.holdings) {
        addStock(h.symbol, h.name, r.displaySymbol, r.value * h.percent, r);
        covered += h.percent;
      }
      const remainder = r.value * Math.max(0, 1 - covered);
      if (remainder > 0) addStock('— diversified —', 'Beyond reported top holdings', r.displaySymbol, remainder, r);
    } else {
      addStock('— non-equity —', 'Bonds / commodities / cash', r.displaySymbol, r.value, r);
    }

    // --- Country / region look-through ---
    // Funds use their constituents' ISIN countries (remainder distributed
    // proportionally); direct stocks use issuer domicile.
    if (r.isCrypto) {
      add(countryMap, 'Crypto', r.displaySymbol, r.value);
    } else if (nonEquityFund) {
      add(countryMap, 'Bonds / Commodities / Cash', r.displaySymbol, r.value);
    } else if (deepHoldings?.length) {
      const covered = deepHoldings.reduce((s, h) => s + h.percent, 0) || 1;
      for (const h of deepHoldings) {
        add(countryMap, h.country ?? 'Other', r.displaySymbol, r.value * (h.percent / covered));
      }
    } else if (meta?.quoteType === 'EQUITY') {
      add(countryMap, meta.country ?? 'United States', r.displaySymbol, r.value);
    } else if (meta?.holdings?.length) {
      add(countryMap, 'International / Other', r.displaySymbol, r.value);
    } else {
      add(countryMap, 'Other', r.displaySymbol, r.value);
    }

    // --- Broad asset-class look-through (Schwab-style buckets) ---
    // A manual override (if any) wins and forces the whole position into one
    // bucket. Otherwise: bond/commodity/cash funds are caught by name, options
    // and REITs by pattern, and equity funds split Domestic vs Foreign by their
    // constituents' countries. `primaryClass` is the single bucket shown for the
    // holding in the positions table (the dominant one for split funds).
    const ne = broadNonEquity(r.displaySymbol, r.name);
    const extra = extraClass(r.displaySymbol, r.name);
    let primaryClass: string;
    if (override) {
      add(assetMap, override, r.displaySymbol, r.value);
      primaryClass = override;
    } else if (r.isCrypto) {
      add(assetMap, 'Crypto', r.displaySymbol, r.value);
      primaryClass = 'Crypto';
    } else if (extra) {
      add(assetMap, extra, r.displaySymbol, r.value);
      primaryClass = extra;
    } else if (ne) {
      add(assetMap, ne, r.displaySymbol, r.value);
      primaryClass = ne;
    } else if (deepHoldings?.length) {
      const covered = deepHoldings.reduce((s, h) => s + h.percent, 0) || 1;
      let us = 0, foreign = 0;
      for (const h of deepHoldings) {
        const v = r.value * (h.percent / covered);
        if ((h.country ?? 'United States') === 'United States') us += v; else foreign += v;
      }
      if (us > 0) add(assetMap, 'Domestic Stock', r.displaySymbol, us);
      if (foreign > 0) add(assetMap, 'Foreign Stock', r.displaySymbol, foreign);
      primaryClass = foreign > us ? 'Foreign Stock' : 'Domestic Stock';
    } else if (meta?.quoteType === 'EQUITY') {
      primaryClass = (meta.country ?? 'United States') === 'United States' ? 'Domestic Stock' : 'Foreign Stock';
      add(assetMap, primaryClass, r.displaySymbol, r.value);
    } else if (meta?.holdings?.length || meta?.sectorWeightings) {
      const intl = /\b(international|intl|ex.?us|world|global|emerging|developed|eafe|pacific|europe|asia|foreign)\b/i.test(`${r.displaySymbol} ${r.name}`);
      primaryClass = intl ? 'Foreign Stock' : 'Domestic Stock';
      add(assetMap, primaryClass, r.displaySymbol, r.value);
    } else {
      add(assetMap, 'Uncategorized', r.displaySymbol, r.value);
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

  return {
    total: grandTotal, holdings, byStock,
    // Equity look-throughs stay relative to invested (brokerage) total so their
    // shares still sum to ~100% of the stock portfolio.
    bySector: toSlices(sectorMap, total),
    byCountry: toSlices(countryMap, total),
    byAssetClass: toSlices(assetMap, grandTotal),
    assetClasses: [...ASSET_CLASSES],
    realEstate,
  };
}
