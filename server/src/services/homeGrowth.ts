import { getDb } from '../db/schema.js';
import { fetchZhviHistories } from './zhvi.js';
import { trailingGrowth, type TrailingGrowth, type ValuePoint } from '../util/homeGrowth.js';

// Each home's own growth rate, for the Dashboard's "Appreciation" line.
//
// Read from the same value history the net-worth chart draws the home with (see
// backfill.ts), in the same order of preference:
//  1. 'history' — value points the user entered or pasted for this home, with
//     today's value appended as the latest point;
//  2. 'zip'     — Zillow's home value index (ZHVI) for the home's ZIP code. The
//     backfill scales that curve to today's value, which leaves its growth rate
//     unchanged, so the unscaled series gives the same answer.
// A home with neither (or under a year of either) is left out, and the caller
// falls back to the Forecast's flat home-growth assumption.

export interface HomeGrowth extends TrailingGrowth {
  source: 'history' | 'zip';
}

interface PropertyRow { id: number; address: string; zestimate: number | null }

/** Growth per property id. Homes without enough history are absent. */
export async function getHomeGrowth(today = new Date().toISOString().slice(0, 10)): Promise<Record<number, HomeGrowth>> {
  const db = getDb();
  const properties = db.prepare('SELECT id, address, zestimate FROM properties').all() as PropertyRow[];
  const manualRows = db
    .prepare('SELECT property_id, date, value FROM property_value_history ORDER BY date')
    .all() as { property_id: number; date: string; value: number }[];
  const manualByProp = new Map<number, ValuePoint[]>();
  for (const r of manualRows) {
    const list = manualByProp.get(r.property_id) ?? [];
    list.push({ date: r.date, value: r.value });
    manualByProp.set(r.property_id, list);
  }

  const out: Record<number, HomeGrowth> = {};
  const needZip: PropertyRow[] = [];
  for (const p of properties) {
    const manual = manualByProp.get(p.id) ?? [];
    // Mirrors the backfill: the current value closes the manual curve.
    const hist = manual.length && p.zestimate && p.zestimate > 0 && manual[manual.length - 1].date < today
      ? [...manual, { date: today, value: p.zestimate }]
      : manual;
    const g = trailingGrowth(hist);
    if (g) out[p.id] = { ...g, source: 'history' };
    else needZip.push(p);
  }

  if (needZip.length) {
    // Cached series answer at once; only a ZIP never fetched before waits on the
    // download. A lookup failure just leaves those homes on the fallback rate.
    const series = await fetchZhviHistories(needZip.map(p => p.address), { staleOk: true }).catch(err => {
      console.error('[homeGrowth] ZHVI lookup failed:', err);
      return needZip.map(() => [] as ValuePoint[]);
    });
    needZip.forEach((p, i) => {
      const g = trailingGrowth(series[i] ?? []);
      if (g) out[p.id] = { ...g, source: 'zip' };
    });
  }
  return out;
}
