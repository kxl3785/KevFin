import { getDb } from '../db/schema.js';

// Read at call time (not module load) so a key saved via Setup applies without
// a server restart.
export async function fetchZestimate(address: string): Promise<number | null> {
  const url = `https://api.openwebninja.com/realtime-zillow-data/property-details-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: {
      'x-api-key': process.env.OPENWEBNINJA_KEY ?? '',
    },
  });

  if (!res.ok) {
    console.error(`Zillow API error ${res.status}:`, await res.text());
    return null;
  }

  const body = await res.json() as { data?: { zestimate?: number; price?: number } };
  const zestimate = body.data?.zestimate ?? body.data?.price ?? null;
  console.log('Zillow zestimate:', zestimate);
  return zestimate;
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
