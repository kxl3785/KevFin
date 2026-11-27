import { describe, it, expect } from 'vitest';
import {
  splitPositions, investedSummary, unrealizedGain, driftPill, offTarget, driftWords, movesText, roundAbout,
  topConcentration, isDirectSource, isPseudoStock, isRealSector, aliasCue, aliasWords, sortPositions, migrateOrder, migrateWidths, cardWidth, cardsFillingRow,
  jumpLinks, feesJumpTarget, INV_ANCHORS, INV_CARDS, measuredTableWidth, locationFit,
  type PositionLike,
} from './investments.ts';
import { rebalance } from './rebalance.ts';

const pos = (p: Partial<PositionLike>): PositionLike => ({
  symbol: '', name: '', value: 0, costBasis: null, costBasisCoveredValue: 0, costBasisComplete: true,
  costBasisSource: null, assetClass: 'Domestic Stock', accounts: [], ...p,
});

const VTI = pos({ symbol: 'VTI', name: 'Total Stock', value: 1000, costBasis: 800, costBasisCoveredValue: 1000, costBasisSource: 'reported', accounts: [{ name: 'Brokerage' }, { name: 'Roth' }] });
const AAPL = pos({ symbol: 'AAPL', name: 'Apple', value: 500, accounts: [{ name: 'Brokerage' }] });
const HOME = pos({ name: '1 Main St', value: 300000, assetClass: 'Real Estate' });
const COINS = pos({ name: 'Coins', value: 2000, costBasis: 1000, costBasisCoveredValue: 2000, assetClass: 'Alternatives' });

describe('invested money vs other assets', () => {
  it('splits on whether a position sits in an account', () => {
    const { invested, other } = splitPositions([HOME, VTI, COINS, AAPL]);
    expect(invested).toEqual([VTI, AAPL]);
    expect(other).toEqual([HOME, COINS]);
  });
  it('totals invested money only, counting distinct accounts', () => {
    expect(investedSummary([HOME, VTI, COINS, AAPL])).toEqual({ total: 1500, accounts: 2, positions: 2 });
  });
});

describe('unrealizedGain', () => {
  it('measures gain on the covered value only', () => {
    const partial = pos({ value: 1000, costBasis: 400, costBasisCoveredValue: 500, costBasisComplete: false, accounts: [{ name: 'A' }] });
    const g = unrealizedGain([VTI, AAPL, partial]);
    expect(g.gain).toBe(1000 + 500 - 800 - 400);
    expect(g.pct).toBeCloseTo(300 / 1200, 10);
    expect(g.withCost).toBe(2);
    expect(g.count).toBe(3);
    expect(g.anyPartial).toBe(true);
  });
  it('is null with no cost basis at all', () => {
    expect(unrealizedGain([AAPL]).gain).toBeNull();
    expect(unrealizedGain([]).pct).toBeNull();
  });
});

describe('allocation against targets', () => {
  const values = { 'Domestic Stock': 75000, 'Foreign Stock': 13000, Bonds: 11500, 'Short Term': 500 };
  const targets = { 'Domestic Stock': 60, 'Foreign Stock': 20, Bonds: 15, 'Short Term': 5 };
  const order = ['Domestic Stock', 'Foreign Stock', 'Bonds', 'Short Term'];
  const result = rebalance(values, targets, 5, order);
  const label = (k: string) => ({ 'Domestic Stock': 'U.S. stocks', 'Foreign Stock': 'Intl. stocks' } as Record<string, string>)[k] ?? k;
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

  it('pills: signed whole points outside the band, "in band" inside', () => {
    expect(driftPill(result.rows[0], 5)).toEqual({ text: '+15 pts', out: true });
    expect(driftPill(result.rows[1], 5)).toEqual({ text: '−7 pts', out: true });
    expect(driftPill(result.rows[2], 5)).toEqual({ text: 'in band', out: false });
  });
  it('pills: a decimal just past the band edge, never "+5 pts" on ±5', () => {
    expect(driftPill({ driftPts: 5.2, inBand: false }, 5).text).toBe('+5.2 pts');
    expect(driftPill({ driftPts: 5.01, inBand: false }, 5).text).toBe('just over ±5');
  });
  it('counts kinds outside the band and names the furthest out', () => {
    expect(offTarget(result)).toEqual({ out: 2, total: 4, worst: { key: 'Domestic Stock', driftPts: result.rows[0].driftPts } });
    expect(offTarget(null)).toBeNull();
    expect(driftWords(15.2)).toBe('15 pts over');
    expect(driftWords(-1)).toBe('1 pt under');
  });
  it('says what to move, from the worksheet amounts, rounded', () => {
    expect(movesText(result, usd, label, 5)).toBe('To get back on target: move about $15,000 out of U.S. stocks, with $7,000 of it into Intl. stocks.');
    expect(roundAbout(44_649)).toBe(44_600);
    expect(roundAbout(-412)).toBe(410);
  });
  it('says so when every kind is in band', () => {
    const calm = rebalance({ 'Domestic Stock': 61, Bonds: 39 }, { 'Domestic Stock': 60, Bonds: 40 }, 5, order);
    expect(movesText(calm, usd, label, 5)).toBe('Every kind sits within ±5 points of its target.');
  });
  it('words a lone underweight kind', () => {
    const r = rebalance({ 'Domestic Stock': 50, Bonds: 50 }, { 'Domestic Stock': 40, Bonds: 60 }, 5, order);
    expect(movesText(r, usd, label, 5)).toBe('To get back on target: move about $10 out of U.S. stocks, with $10 of it into Bonds.');
    const under = rebalance({ 'Domestic Stock': 5000, Bonds: 3000, 'Short Term': 2000 }, { 'Domestic Stock': 50, Bonds: 40, 'Short Term': 10 }, 5, order);
    expect(movesText(under, usd, label, 5)).toBe('To get back on target: move about $1,000 out of Short Term, with $1,000 of it into Bonds.');
    const over = rebalance({ 'Domestic Stock': 70, 'Foreign Stock': 15, Bonds: 15 }, { 'Domestic Stock': 60, 'Foreign Stock': 20, Bonds: 20 }, 5, order);
    expect(movesText(over, usd, label, 5)).toBe('To get back on target: move about $10 out of U.S. stocks into the other kinds.');
  });
});

describe('what you own', () => {
  it('recognises the pseudo-rows', () => {
    expect(isPseudoStock('— non-equity —')).toBe(true);
    expect(isPseudoStock('AAPL')).toBe(false);
    expect(isRealSector('Technology')).toBe(true);
    expect(isRealSector('Bonds')).toBe(false);
  });
  // Sources shaped as the server sends them: a directly held share is labelled
  // "Direct holding", a fund's part by the fund's ticker.
  it('sums the top real stocks and how much came through funds', () => {
    const c = topConcentration([
      { symbol: 'AAPL', value: 300, pct: 0.3, sources: [{ label: 'VTI', value: 200 }, { label: 'Direct holding', value: 100 }] },
      { symbol: '— non-equity —', value: 900, pct: 0.9, sources: [] },
      { symbol: 'MSFT', value: 200, pct: 0.2, sources: [{ label: 'VTI', value: 200 }] },
      { symbol: 'NVDA', value: 100, pct: 0.1, sources: [{ label: 'VTI', value: 100 }] },
      { symbol: 'AMZN', value: 50, pct: 0.05, sources: [] },
    ]);
    expect(c!.symbols).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(c!.pct).toBeCloseTo(0.6, 10);
    expect(c!.viaFunds).toBeCloseTo(500 / 600, 10);
  });
  it('reads mostly-direct holdings as direct', () => {
    const c = topConcentration([
      { symbol: 'AAPL', value: 600, pct: 0.3, sources: [{ label: 'Direct holding', value: 500 }, { label: 'VTI', value: 100 }] },
      { symbol: 'MSFT', value: 400, pct: 0.2, sources: [{ label: 'Direct holding', value: 300 }, { label: 'VOO', value: 100 }] },
      { symbol: 'NVDA', value: 200, pct: 0.1, sources: [{ label: 'VTI', value: 200 }] },
    ]);
    expect(c!.viaFunds).toBeCloseTo(400 / 1200, 10);
    expect(isDirectSource('Crypto holding')).toBe(true);
    expect(isDirectSource('VTI')).toBe(false);
  });
  it('is null with too few stocks to call it concentration', () => {
    expect(topConcentration([{ symbol: 'AAPL', value: 1, pct: 1, sources: [] }])).toBeNull();
  });
  it('shortens a merged row’s other tickers to the first and a count', () => {
    expect(aliasCue(['GOOG'])).toBe('GOOG');
    expect(aliasCue(['CIBEST', 'PFCIBEST'])).toBe('CIBEST +1');
    expect(aliasCue(['A', 'B', 'C'])).toBe('A +2');
    expect(aliasCue([])).toBe('');
  });
  it('says every other ticker in words', () => {
    expect(aliasWords(['GOOG'])).toBe('also GOOG');
    expect(aliasWords(['CIBEST', 'PFCIBEST'])).toBe('also CIBEST and PFCIBEST');
    expect(aliasWords(['A', 'B', 'C'])).toBe('also A, B and C');
    expect(aliasWords([])).toBe('');
  });
});

describe('sortPositions', () => {
  const rows = [AAPL, VTI, pos({ symbol: 'BND', value: 700, costBasis: 900, costBasisCoveredValue: 700, accounts: [{ name: 'A' }] })];
  it('sorts numbers largest first and text A→Z, missing values last', () => {
    expect(sortPositions(rows, { key: 'value', dir: 'desc' }).map(r => r.symbol)).toEqual(['VTI', 'BND', 'AAPL']);
    expect(sortPositions(rows, { key: 'name', dir: 'asc' }).map(r => r.symbol)).toEqual(['AAPL', 'BND', 'VTI']);
    expect(sortPositions(rows, { key: 'gain', dir: 'desc' }).map(r => r.symbol)).toEqual(['VTI', 'BND', 'AAPL']);
    expect(sortPositions(rows, { key: 'gain', dir: 'asc' }).map(r => r.symbol)).toEqual(['BND', 'VTI', 'AAPL']);
  });
  it('reads fee columns through the lookup', () => {
    const fees: Record<string, { expenseRatio: number | null; annualCost: number | null }> = {
      VTI: { expenseRatio: 0.0003, annualCost: 0.3 }, AAPL: { expenseRatio: 0, annualCost: 0 },
    };
    expect(sortPositions(rows, { key: 'feeCost', dir: 'desc' }, h => fees[h.symbol]).map(r => r.symbol)).toEqual(['VTI', 'AAPL', 'BND']);
  });
});

describe('saved card layout', () => {
  it('migrates the earlier page\'s card names without losing a card', () => {
    expect(migrateOrder(['assets', 'country', 'sector', 'stock', 'positions'])).toEqual(['assets', 'exposure', 'positions', 'location', 'fees', 'bonds']);
    expect(migrateOrder(['positions', 'stock', 'bonds', 'assets'])).toEqual(['positions', 'location', 'fees', 'exposure', 'bonds', 'assets']);
  });
  it('falls back to the default order for junk', () => {
    expect(migrateOrder(null)).toEqual(['assets', 'exposure', 'positions', 'location', 'fees', 'bonds']);
    expect(migrateOrder(['nope', 3, 'positions', 'positions'])).toEqual(['assets', 'exposure', 'positions', 'location', 'fees', 'bonds']);
  });
  it('puts Fund fees beside "Where your investments sit" in a layout saved before it existed', () => {
    expect(migrateOrder(['assets', 'exposure', 'positions', 'location', 'bonds'])).toEqual(['assets', 'exposure', 'positions', 'location', 'fees', 'bonds']);
    expect(migrateOrder(['location', 'bonds', 'positions', 'assets', 'exposure'])).toEqual(['location', 'fees', 'bonds', 'positions', 'assets', 'exposure']);
    // Once saved, its place is kept wherever the user moved it.
    expect(migrateOrder(['fees', 'assets', 'exposure', 'positions', 'location', 'bonds'])).toEqual(['fees', 'assets', 'exposure', 'positions', 'location', 'bonds']);
  });
  it('starts Fund fees at half width, and keeps a saved width for it', () => {
    expect(cardWidth({}, 'fees')).toBe('half');
    expect(migrateWidths({ fees: 'full', location: 'half' })).toEqual({ fees: 'full', location: 'half' });
  });
  it('keeps only known widths', () => {
    expect(migrateWidths({ positions: 'half', country: 'full', assets: 'wide' })).toEqual({ positions: 'half' });
    expect(migrateWidths('x')).toEqual({});
  });
  it('fills a row when a half card has nothing beside it', () => {
    const full = new Set(['positions']);
    expect([...cardsFillingRow(['assets', 'exposure', 'positions', 'location'], k => full.has(k))]).toEqual(['location']);
    expect([...cardsFillingRow(['assets', 'positions', 'exposure', 'bonds'], k => full.has(k))]).toEqual(['assets']);
  });
});

describe('jump row', () => {
  it('links every card on screen, in the order shown, after Overview', () => {
    expect(jumpLinks(['positions', 'assets', 'location', 'fees']).map(j => j.id))
      .toEqual(['inv-overview', 'inv-positions', 'inv-allocation', 'inv-location', 'inv-fees']);
  });
  it('gives Bond quality a link only when the card is there', () => {
    expect(jumpLinks(['assets', 'bonds']).map(j => j.label)).toEqual(['Overview', 'Allocation', 'Bond quality']);
    expect(jumpLinks(['assets']).some(j => j.id === 'inv-bonds')).toBe(false);
  });
  it('has an anchor for every card, with unique ids; only the Fund fees card says "fees"', () => {
    for (const k of INV_CARDS) expect(INV_ANCHORS[k]).toBeTruthy();
    const ids = Object.values(INV_ANCHORS).map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.entries(INV_ANCHORS).filter(([, a]) => /fee/i.test(a.label)).map(([k]) => k)).toEqual(['fees']);
    expect(INV_ANCHORS.fees).toEqual({ id: 'inv-fees', label: 'Fund fees' });
  });
  it('sends the Fund fees tile to its card when shown, else to Positions', () => {
    expect(feesJumpTarget(['assets', 'positions', 'fees'])).toBe('inv-fees');
    expect(feesJumpTarget(['assets', 'positions'])).toBe('inv-positions');
  });
});

describe('asset-location table fit', () => {
  it('sums each column at its widest, padding all but the first', () => {
    expect(measuredTableWidth([{ header: 0, cells: [90, 60] }, { header: 70, cells: [50, 40] }, { header: 30, cells: [80] }], 12)).toBe(90 + 12 + 70 + 12 + 80);
    expect(measuredTableWidth([], 12)).toBe(0);
  });
  const W = { full: 640, compact: 480, tight: 420 };
  it('keeps full figures when they fit, then steps down, and scrolls only when nothing fits', () => {
    expect(locationFit(700, W)).toEqual({ layout: 'full', scroll: false });
    expect(locationFit(640, W)).toEqual({ layout: 'full', scroll: false });
    expect(locationFit(565, W)).toEqual({ layout: 'compact', scroll: false });
    expect(locationFit(440, W)).toEqual({ layout: 'tight', scroll: false });
    expect(locationFit(300, W)).toEqual({ layout: 'compact', scroll: true });
  });
  it('shows the full figures in a scroll area until the card is measured', () => {
    expect(locationFit(null, W)).toEqual({ layout: 'full', scroll: true });
  });
});
