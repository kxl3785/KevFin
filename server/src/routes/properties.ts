import { Router, type Request, type Response } from 'express';
import { addProperty, removeProperty, fetchZestimate } from '../services/zillow.js';
import { takeSnapshot } from '../services/netWorth.js';
import { backfillHistory } from '../services/backfill.js';
import { getDb } from '../db/schema.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM properties ORDER BY address').all());
});

router.post('/', async (req: Request, res: Response) => {
  const { address } = req.body as { address: string };
  if (!address) return res.status(400).json({ error: 'address required' });

  addProperty(address);

  // Best-effort: a Zestimate fetch failure (offline, provider down) must not
  // reject the handler — Express 4 would leave the request hanging and the
  // unhandled rejection would take the process down.
  let zestimate: number | null = null;
  try {
    zestimate = await fetchZestimate(address);
  } catch (err) {
    console.error('[properties] zestimate fetch failed:', err);
  }
  if (zestimate !== null) {
    const db = getDb();
    db.prepare(`UPDATE properties SET zestimate = ?, updated_at = datetime('now') WHERE address = ?`)
      .run(zestimate, address);
  }

  const db = getDb();
  takeSnapshot();
  res.json(db.prepare('SELECT * FROM properties WHERE address = ?').get(address));
});

// PATCH body field → properties column. value → zestimate; mortgage_balance is
// the manual override (used when no loan terms are set); mortgage_* are the
// amortization inputs. A field sent as null clears it.
const PATCH_COLS: Record<string, string> = {
  value: 'zestimate',
  mortgage_balance: 'mortgage_balance',
  mortgage_principal: 'mortgage_principal',
  mortgage_rate: 'mortgage_rate',
  mortgage_start: 'mortgage_start',
  mortgage_term_years: 'mortgage_term_years',
  property_tax_annual: 'property_tax_annual',
  insurance_annual: 'insurance_annual',
  hoa_annual: 'hoa_annual',
  rental_income_annual: 'rental_income_annual',
};

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());
}

// Validate everything first so a bad value can't leave a half-applied
// multi-column update. All fields are numeric except mortgage_start (a
// YYYY-MM-DD string); anything else would be stored as TEXT under REAL affinity
// and silently sum as 0 in snapshots. A term of 0 (or a start the amortization
// can't parse) would make the schedule report a zero balance — silently erasing
// the liability — so both are rejected here.
export function parsePropertyPatch(
  body: Record<string, unknown>,
): { updates: [string, number | string | null][] } | { error: string } {
  const updates: [string, number | string | null][] = [];
  for (const [key, col] of Object.entries(PATCH_COLS)) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (key === 'mortgage_start') {
      if (raw !== null && (typeof raw !== 'string' || !isIsoDate(raw))) {
        return { error: 'mortgage_start must be YYYY-MM-DD or null.' };
      }
      updates.push([col, raw as string | null]);
      continue;
    }
    if (raw === null) {
      updates.push([col, key === 'mortgage_balance' ? 0 : null]); // column is NOT NULL
      continue;
    }
    const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return { error: `${key} must be a number or null.` };
    if (key === 'mortgage_term_years' && n <= 0) return { error: 'mortgage_term_years must be greater than 0.' };
    updates.push([col, n]);
  }
  return { updates };
}

router.patch('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const parsed = parsePropertyPatch((req.body ?? {}) as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  db.transaction(() => {
    for (const [col, val] of parsed.updates) {
      db.prepare(`UPDATE properties SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).run(val, id);
    }
  })();

  takeSnapshot(); // recomputes amortized balances + re-snapshots net worth
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(id));
});

router.delete('/:id', (req: Request, res: Response) => {
  removeProperty(Number(req.params.id));
  takeSnapshot();
  res.json({ success: true });
});

// --- Manual per-property value (Zestimate) history --------------------------
// Points entered here override the (ZIP-level) ZHVI curve for this property in
// the backfill, giving true house-specific history. Each edit rebuilds the
// historical snapshots so the chart reflects the change immediately.

function listHistory(id: number) {
  return getDb()
    .prepare('SELECT date, value FROM property_value_history WHERE property_id = ? ORDER BY date')
    .all(id);
}

router.get('/:id/history', (req: Request, res: Response) => {
  res.json(listHistory(Number(req.params.id)));
});

router.put('/:id/history', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const date = typeof req.body?.date === 'string' ? req.body.date : '';
  const value = Number(req.body?.value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'A date (YYYY-MM-DD) and a positive value are required.' });
  }
  // Manual points feed the backfill — rebuild it now. Best-effort: the point is
  // saved first, and neither a DB nor a provider failure may crash the process
  // (Express 4 doesn't catch async handler rejections).
  try {
    getDb()
      .prepare('INSERT OR REPLACE INTO property_value_history (property_id, date, value) VALUES (?, ?, ?)')
      .run(id, date, value);
    await backfillHistory();
  } catch (err) {
    console.error('[properties] history edit or rebuild failed:', err);
  }
  res.json(listHistory(id));
});

router.delete('/:id/history/:date', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    getDb()
      .prepare('DELETE FROM property_value_history WHERE property_id = ? AND date = ?')
      .run(id, req.params.date);
    await backfillHistory();
  } catch (err) {
    console.error('[properties] history delete or rebuild failed:', err);
  }
  res.json(listHistory(id));
});

// Bulk import — the whole Zestimate table pasted from Zillow, parsed client-side
// into {date, value} rows. Upsert them all in one transaction, then rebuild once.
router.put('/:id/history/bulk', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const raw: unknown[] = Array.isArray(req.body?.points) ? req.body.points : [];
  const points = raw
    .map(p => {
      const row = p as { date?: unknown; value?: unknown };
      return { date: String(row?.date ?? ''), value: Number(row?.value) };
    })
    .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.value) && p.value > 0);
  if (!points.length) return res.status(400).json({ error: 'No valid rows found in the pasted table.' });

  try {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO property_value_history (property_id, date, value) VALUES (?, ?, ?)');
    db.transaction((rows: { date: string; value: number }[]) => {
      for (const r of rows) stmt.run(id, r.date, r.value);
    })(points);
    await backfillHistory();
  } catch (err) {
    console.error('[properties] bulk import or rebuild failed:', err);
  }
  res.json(listHistory(id));
});

export default router;
