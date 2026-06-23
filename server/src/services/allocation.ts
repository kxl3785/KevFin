import { getDb } from '../db/schema.js';
import { fetchHoldings } from './simplefin.js';
import { effectiveChain } from './prices.js';
import { fetchSecurityMeta } from './yahooMeta.js';
import { fetchDeepConstituents, type Constituent } from './fundHoldings.js';

export interface Contributor { label: string; value: number }
export interface Slice { name: string; value: number; pct: number; contributors: Contributor[] }
export interface AccountHolding { name: string; value: number }
export interface StockExposure { symbol: string; name: string; value: number; pct: number; sources: Contributor[]; accounts: AccountHolding[] }
export interface HoldingRow { symbol: string; name: string; value: number; pct: number; assetClass: string; accounts: AccountHolding[] }
export interface Allocation {
  total: number;
  holdings: HoldingRow[];
  bySector: Slice[];
  byStock: StockExposure[];
  byCountry: Slice[];
  byAssetClass: Slice[];
}

function assetClassOf(quoteType: string | null, isCrypto: boolean): string {
  if (isCrypto) return 'Crypto';
  switch (quoteType) {
    case 'ETF': return 'ETFs';
    case 'EQUITY': return 'Stocks';
    case 'MUTUALFUND': return 'Mutual Funds';
    case 'CRYPTOCURRENCY': return 'Crypto';
    default: return 'Other';
  }
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

export async function getAllocation(): Promise<Allocation> {
  const db = getDb();
  const accts = db.prepare('SELECT id, name, category, hidden FROM accounts').all() as {
    id: string; name: string; category: string; hidden: number;
  }[];
  const brokerage = new Map(accts.filter(a => a.category === 'brokerage' && !a.hidden).map(a => [a.id, a.name]));

  const holdingsByAccount = await fetchHoldings();

  const agg = new Map<string, { displaySymbol: string; metaSymbol: string; name: string; value: number; isCrypto: boolean; accounts: Map<string, number> }>();
  for (const [accId, holdings] of holdingsByAccount) {
    if (!brokerage.has(accId)) continue;
    const accountName = brokerage.get(accId) ?? 'Unknown';
    const accountIsCrypto = /crypto/i.test(accountName);
    for (const h of holdings) {
      const metaSymbol = effectiveChain(h.symbol, h.description)[0] ?? '';
      const displaySymbol = h.symbol || metaSymbol || '';
      const key = displaySymbol || h.description || 'Unknown';
      const isCrypto = isCryptoAsset(h.symbol, h.description, accountIsCrypto);
      const row = agg.get(key) ?? { displaySymbol, metaSymbol, name: h.description || displaySymbol || key, value: 0, isCrypto, accounts: new Map<string, number>() };
      row.value += h.marketValue;
      row.accounts.set(accountName, (row.accounts.get(accountName) ?? 0) + h.marketValue);
      agg.set(key, row);
    }
  }

  const rows = [...agg.values()];
  const total = rows.reduce((s, r) => s + r.value, 0);

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
  const addStock = (sym: string, name: string, source: string, value: number, row: { accounts: Map<string, number>; value: number }) => {
    const e = stockMap.get(sym) ?? { name, sources: new Map<string, number>(), accounts: new Map<string, number>() };
    e.sources.set(source, (e.sources.get(source) ?? 0) + value);
    if (row.value > 0) for (const [a, v] of row.accounts) e.accounts.set(a, (e.accounts.get(a) ?? 0) + value * (v / row.value));
    stockMap.set(sym, e);
  };

  for (const r of rows) {
    const meta = r.metaSymbol ? metas.get(r.metaSymbol) : undefined;
    const cls = assetClassOf(meta?.quoteType ?? null, r.isCrypto);
    holdings.push({
      symbol: r.displaySymbol, name: r.name, value: r.value, pct: total ? r.value / total : 0, assetClass: cls,
      accounts: [...r.accounts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    });

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
    // Bond/commodity/cash funds are caught by name first; equity funds split
    // into Domestic vs Foreign by their constituents' countries.
    const ne = broadNonEquity(r.displaySymbol, r.name);
    if (r.isCrypto) {
      add(assetMap, 'Crypto', r.displaySymbol, r.value);
    } else if (ne) {
      add(assetMap, ne, r.displaySymbol, r.value);
    } else if (deepHoldings?.length) {
      const covered = deepHoldings.reduce((s, h) => s + h.percent, 0) || 1;
      let us = 0, foreign = 0;
      for (const h of deepHoldings) {
        const v = r.value * (h.percent / covered);
        if ((h.country ?? 'United States') === 'United States') us += v; else foreign += v;
      }
      if (us > 0) add(assetMap, 'Domestic Stock', r.displaySymbol, us);
      if (foreign > 0) add(assetMap, 'Foreign Stock', r.displaySymbol, foreign);
    } else if (meta?.quoteType === 'EQUITY') {
      add(assetMap, (meta.country ?? 'United States') === 'United States' ? 'Domestic Stock' : 'Foreign Stock', r.displaySymbol, r.value);
    } else if (meta?.holdings?.length || meta?.sectorWeightings) {
      const intl = /\b(international|intl|ex.?us|world|global|emerging|developed|eafe|pacific|europe|asia|foreign)\b/i.test(`${r.displaySymbol} ${r.name}`);
      add(assetMap, intl ? 'Foreign Stock' : 'Domestic Stock', r.displaySymbol, r.value);
    } else {
      add(assetMap, 'Uncategorized', r.displaySymbol, r.value);
    }
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
    total, holdings, byStock,
    bySector: toSlices(sectorMap, total),
    byCountry: toSlices(countryMap, total),
    byAssetClass: toSlices(assetMap, total),
  };
}
