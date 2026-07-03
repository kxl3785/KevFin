import { getDb } from '../db/schema.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch a property's current Zestimate. A licensed API is required: Zillow's own
// property pages are behind PerimeterX (a JS "sensor" challenge, not an IP
// block), so a plain server-side fetch can't reach the Zestimate. We try
// OpenWeb Ninja first and fall back to APILLOW — so when the OpenWeb Ninja plan
// hits its monthly limit (HTTP 429), lookups keep working via APILLOW. Each
// provider returns null on any failure (missing key, over quota, bad shape), so
// we simply roll to the next. With neither configured we return null; the
// property is still added, and the user can type a value by hand.
//
// Env is read at call time so a key saved via Setup applies without a restart.
export async function fetchZestimate(address: string): Promise<number | null> {
  const viaOwn = await fetchViaOpenWebNinja(address);
  if (viaOwn !== null) return viaOwn;
  return fetchViaApillow(address);
}

// Primary provider: OpenWeb Ninja's Real-Time Zillow Data API (address-based, so
// no zpid lookup needed).
async function fetchViaOpenWebNinja(address: string): Promise<number | null> {
  const apiKey = process.env.OPENWEBNINJA_KEY;
  if (!apiKey) return null;

  const url = `https://api.openwebninja.com/realtime-zillow-data/property-details-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });

  if (!res.ok) {
    // 429 (plan limit) is expected — logged, then we fall back to APILLOW.
    console.error(`OpenWeb Ninja error ${res.status}:`, await res.text());
    return null;
  }

  const body = await res.json() as { data?: { zestimate?: number; price?: number } };
  const zestimate = body.data?.zestimate ?? body.data?.price ?? null;
  if (zestimate !== null) console.log('Zillow zestimate (OpenWeb Ninja):', zestimate);
  return zestimate;
}

// Fallback provider: APILLOW. It's a job-based API — POST an address to get a
// job_id, then poll for results (typically ready in 3-10s). We give it ~15s
// before giving up so a slow lookup doesn't hang the add-property request forever.
async function fetchViaApillow(address: string): Promise<number | null> {
  const apiKey = process.env.APILLOW_KEY;
  if (!apiKey) return null;

  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };

  // 1. Submit the address; APILLOW returns a job_id immediately.
  const submit = await fetch('https://api.apillow.co/v1/properties', {
    method: 'POST',
    headers,
    body: JSON.stringify({ addresses: [address] }),
  });
  if (!submit.ok) {
    console.error(`APILLOW submit error ${submit.status}:`, await submit.text());
    return null;
  }
  const jobId = (await submit.json() as { job_id?: string }).job_id;
  if (!jobId) {
    console.error('APILLOW: no job_id in submit response');
    return null;
  }

  // 2. Poll the results endpoint until the job completes (or fails / times out).
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(1300);
    const res = await fetch(`https://api.apillow.co/v1/results/${jobId}`, { headers });
    if (!res.ok) {
      console.error(`APILLOW results error ${res.status}:`, await res.text());
      return null;
    }
    const body = await res.json() as {
      status?: string;
      results?: { property?: { zestimate?: number | null; price?: number | null } }[];
    };
    if (body.status === 'complete') {
      const prop = body.results?.[0]?.property;
      const zestimate = prop?.zestimate ?? prop?.price ?? null;
      if (zestimate !== null) console.log('Zillow zestimate (APILLOW):', zestimate);
      return zestimate;
    }
    if (body.status === 'failed') {
      console.error(`APILLOW: job failed for "${address}"`);
      return null;
    }
    // otherwise 'processing' → keep polling
  }
  console.warn(`APILLOW: timed out waiting for results for "${address}"`);
  return null;
}

export async function refreshAllProperties(): Promise<void> {
  const db = getDb();
  const properties = db.prepare('SELECT id, address FROM properties').all() as {
    id: number;
    address: string;
  }[];

  const update = db.prepare(`
    UPDATE properties SET zestimate = ?, updated_at = datetime('now') WHERE id = ?
  `);

  for (const prop of properties) {
    const zestimate = await fetchZestimate(prop.address);
    if (zestimate !== null) {
      update.run(zestimate, prop.id);
    }
  }
}

export function addProperty(address: string): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO properties (address) VALUES (?)`).run(address);
}

export function removeProperty(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM properties WHERE id = ?`).run(id);
}
