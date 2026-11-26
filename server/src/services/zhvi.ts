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

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '),
);

// The ZIP typed into an address, or null. Street numbers can also be 5 digits
// ("12345 Main St"), so a bare 5-digit token only counts when it is positioned
// like a ZIP: right after a comma or a state code, or as the final token.
// Anything else returns null and the caller falls back to autocomplete lookup.
export function extractZip(address: string): string | null {
  let zip: string | null = null;
  for (const m of address.matchAll(/(?:^|[\s,])(\d{5})(?:-\d{4})?(?=$|[\s,])/g)) {
    const at = m.index! + m[0].indexOf(m[1]);
    const before = address.slice(0, at).trimEnd();
    const after = address.slice(at + 5).replace(/^-\d{4}/, '').trim();
    const prevTok = before.split(/[\s,]+/).filter(Boolean).pop() ?? '';
    const afterComma = before.endsWith(',');
    const afterState = US_STATES.has(prevTok.toUpperCase());
    const isLast = after === '';
    if (before && (afterComma || afterState || isLast)) zip = m[1];
  }
  return zip;
}

// Resolve a ZIP for an address. Prefer a literal ZIP typed into the address; if
// there isn't one (users often enter just a street, e.g. "2441 Worthington St"),
// fall back to Zillow's open autocomplete CDN — the same keyless endpoint used to
// resolve a zpid — which returns a zipCode. Without this, ZHVI has no series to
// anchor and the property's history stays flat at its current value.
async function resolveZip(address: string): Promise<string | null> {
  const inline = extractZip(address);
  if (inline) return inline;
  // An address's ZIP never changes, so a looked-up one is remembered: the
  // Dashboard asks on every load (home growth) and must not re-ask Zillow.
  const zipKey = `zhvi_zip_${address.trim().toLowerCase()}`;
  const known = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(zipKey) as { value: string } | undefined;
  if (known && /^\d{5}$/.test(known.value)) return known.value;
  try {
    const url =
      'https://www.zillowstatic.com/autocomplete/v3/suggestions' +
      `?q=${encodeURIComponent(address)}&resultTypes=allAddress`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      results?: { resultType?: string; metaData?: { zipCode?: string } }[];
    };
    const hit = body.results?.find(r => r.resultType === 'Address' && r.metaData?.zipCode);
    const zip = hit?.metaData?.zipCode ?? null;
    if (zip && /^\d{5}$/.test(zip)) {
      getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(zipKey, zip);
    }
    return zip;
  } catch {
    return null;
  }
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
// Returns null on a transport failure (bad status, mid-stream error) so the
// caller keeps any previously cached series instead of overwriting it with
// empty; a completed scan that simply didn't contain a ZIP is a genuine miss.
async function downloadSeries(zips: Set<string>): Promise<Map<string, ValuePoint[]> | null> {
  const found = new Map<string, ValuePoint[]>();
  let res: Response;
  try {
    res = await fetch(ZHVI_URL);
  } catch (err) {
    console.error('[zhvi] download failed:', err);
    return null;
  }
  if (!res.ok || !res.body) {
    console.error(`[zhvi] download failed: HTTP ${res.status}`);
    return null;
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

// After a failed download, page loads wait before trying again: the Dashboard
// would otherwise restart a ~120 MB transfer on every load while Zillow is down.
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
let lastFailureAt = 0;
// One download at a time per set of ZIPs: concurrent callers share it.
const inflight = new Map<string, Promise<void>>();

/** Test hook: forget in-flight downloads and the failure back-off. */
export function resetZhviDownloadState(): void {
  inflight.clear();
  lastFailureAt = 0;
}

// Download and cache the series for these ZIPs. Never rejects. `backOff` skips
// the attempt shortly after a failure; the history rebuild leaves it off, since
// its curves depend on this data and an explicit rebuild should always try.
function refresh(zips: Set<string>, backOff = false): Promise<void> {
  const key = [...zips].sort().join(',');
  const pending = inflight.get(key);
  if (pending) return pending;
  if (backOff && Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
  const run = (async () => {
    console.log(`[zhvi] fetching ZHVI for ${key} …`);
    const fetched = await downloadSeries(zips).catch(err => {
      console.error('[zhvi] download failed:', err);
      return null;
    });
    if (fetched) {
      // Cache every requested ZIP — even misses (empty) — so we don't re-download.
      const now = Date.now();
      for (const z of zips) writeCache(z, { fetchedAt: now, series: fetched.get(z) ?? [] });
      console.log(`[zhvi] cached ${[...zips].map(z => `${z}:${(fetched.get(z) ?? []).length}pts`).join(', ')}`);
    } else {
      lastFailureAt = Date.now();
      console.log('[zhvi] download failed — keeping previously cached series');
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/**
 * Per-address ZHVI monthly series (anchored later to each Zestimate by the
 * caller). Returns [] for an address whose ZIP can't be resolved or found —
 * the caller then holds that property's value flat.
 *
 * `staleOk` is for page loads: a ZIP that already has a cached series is
 * answered from it at once, and an out-of-date one is refreshed in the
 * background for next time. Only a ZIP with no cached series at all waits for
 * the download.
 */
export async function fetchZhviHistories(
  addresses: string[],
  opts: { staleOk?: boolean } = {},
): Promise<ValuePoint[][]> {
  const zips = await Promise.all(addresses.map(resolveZip));
  const now = Date.now();

  const missing = new Set<string>();
  const stale = new Set<string>();
  for (const z of zips) {
    if (!z) continue;
    const c = readCache(z);
    if (!c) missing.add(z);
    else if (now - c.fetchedAt > TTL_MS) stale.add(z);
  }

  if (opts.staleOk) {
    if (missing.size) await refresh(missing, true);
    if (stale.size) void refresh(stale, true);
  } else if (missing.size || stale.size) {
    await refresh(new Set([...missing, ...stale]));
  }

  return zips.map(z => (z ? (readCache(z)?.series ?? []) : []));
}
