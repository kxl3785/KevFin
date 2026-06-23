import { getDb } from '../db/schema.js';

/**
 * Zillow Home Value Index (ZHVI) — a smoothed, seasonally-adjusted measure of
 * typical home value, published monthly at ZIP granularity by Zillow Research
 * as a free public CSV. We use it as the historical *shape* for real estate:
 * each property's curve is the ZHVI series for its ZIP, scaled so the latest
 * point equals the property's current Zestimate (see backfill.ts).
 *
 * The CSV is ~120 MB (every US ZIP × ~300 months), so we stream it, keep only
 * the rows for the ZIPs we need, and cache each per-ZIP series in `meta`
 * (refreshed roughly monthly, matching ZHVI's release cadence).
 */
const ZHVI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv';
const TTL_MS = 25 * 24 * 60 * 60 * 1000; // ~monthly

export type ValuePoint = { date: string; value: number };
interface CacheEntry { fetchedAt: number; series: ValuePoint[] }

// Last 5-digit token in an address (street numbers can be 5 digits, so take the last).
function extractZip(address: string): string | null {
  const matches = address.match(/\b\d{5}\b/g);
  return matches ? matches[matches.length - 1] : null;
}

function readCache(zip: string): CacheEntry | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(`zhvi_${zip}`) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function writeCache(zip: string, entry: CacheEntry): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`zhvi_${zip}`, JSON.stringify(entry));
}

// Quote-aware CSV line split (Metro/County names contain commas).
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Stream the ZHVI CSV and extract a monthly series for each requested ZIP.
async function downloadSeries(zips: Set<string>): Promise<Map<string, ValuePoint[]>> {
  const found = new Map<string, ValuePoint[]>();
  const res = await fetch(ZHVI_URL);
  if (!res.ok || !res.body) {
    console.error(`[zhvi] download failed: HTTP ${res.status}`);
    return found;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let zipIdx = -1;
  let dateCols: { idx: number; date: string }[] = [];

  const processLine = (line: string) => {
    if (!line) return;
    const cells = splitCsv(line);
    if (zipIdx === -1) { // header
      zipIdx = cells.indexOf('RegionName');
      dateCols = cells
        .map((c, idx) => ({ idx, date: c }))
        .filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.date));
      return;
    }
    const zip = cells[zipIdx];
    if (!zips.has(zip) || found.has(zip)) return;
    const series: ValuePoint[] = [];
    for (const { idx, date } of dateCols) {
      const v = parseFloat(cells[idx]);
      if (!isNaN(v) && v > 0) series.push({ date, value: v });
    }
    found.set(zip, series);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      processLine(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
    if (found.size === zips.size) { await reader.cancel(); break; } // got them all
  }
  if (buf) processLine(buf);
  return found;
}

/**
 * Per-address ZHVI monthly series (anchored later to each Zestimate by the
 * caller). Returns [] for an address whose ZIP can't be resolved or found —
 * the caller then holds that property's value flat.
 */
export async function fetchZhviHistories(addresses: string[]): Promise<ValuePoint[][]> {
  const zips = addresses.map(extractZip);
  const now = Date.now();

  const stale = new Set<string>();
  for (const z of zips) {
    if (!z) continue;
    const c = readCache(z);
    if (!c || now - c.fetchedAt > TTL_MS) stale.add(z);
  }

  if (stale.size) {
    console.log(`[zhvi] fetching ZHVI for ${[...stale].join(', ')} …`);
    const fetched = await downloadSeries(stale);
    // Cache every requested ZIP — even misses (empty) — so we don't re-download.
    for (const z of stale) writeCache(z, { fetchedAt: now, series: fetched.get(z) ?? [] });
    console.log(`[zhvi] cached ${[...stale].map(z => `${z}:${(fetched.get(z) ?? []).length}pts`).join(', ')}`);
  }

  return zips.map(z => (z ? (readCache(z)?.series ?? []) : []));
}
