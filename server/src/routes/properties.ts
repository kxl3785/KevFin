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

router.patch('/:id', (req: Request, res: Response) => {
  // value → zestimate; mortgage_balance → manual override (used when no loan
  // terms are set); mortgage_* are amortization inputs. Any field sent as null
  // clears it. takeSnapshot() recomputes amortized balances afterward.
  const body = req.body as Record<string, number | string | null | undefined>;
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const cols: Record<string, string> = {
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
  // Validate everything first, then write in one transaction — a bad value
  // mid-loop must not leave a half-applied multi-column update. All fields are
  // numeric except mortgage_start (a date string); anything else would be
  // stored as TEXT under REAL affinity and silently sum as 0 in snapshots.
  const updates: { col: string; val: number | string | null }[] = [];
  for (const [key, col] of Object.entries(cols)) {
    if (body[key] === undefined) continue;
    let val = body[key] as number | string | null;
    if (val !== null) {
      if (key === 'mortgage_start') {
        if (typeof val !== 'string') return res.status(400).json({ error: 'mortgage_start must be a date string or null' });
      } else {
        val = Number(val);
        if (!Number.isFinite(val)) return res.status(400).json({ error: `${key} must be a number or null` });
      }
    }
    updates.push({ col, val });
  }
  db.transaction(() => {
    for (const u of updates) {
      db.prepare(`UPDATE properties SET ${u.col} = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(u.val, id);
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
  getDb()
    .prepare('INSERT OR REPLACE INTO property_value_history (property_id, date, value) VALUES (?, ?, ?)')
    .run(id, date, value);
  // Manual points feed the backfill — rebuild it now. Best-effort: the point is
  // already saved, and a provider failure inside the rebuild must not crash the
  // process (Express 4 doesn't catch async handler rejections).
  try {
    await backfillHistory();
  } catch (err) {
    console.error('[properties] backfill after history edit failed:', err);
  }
  res.json(listHistory(id));
});

router.delete('/:id/history/:date', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  getDb()
    .prepare('DELETE FROM property_value_history WHERE property_id = ? AND date = ?')
    .run(id, req.params.date);
  try {
    await backfillHistory();
  } catch (err) {
    console.error('[properties] backfill after history delete failed:', err);
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

  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO property_value_history (property_id, date, value) VALUES (?, ?, ?)');
  db.transaction((rows: { date: string; value: number }[]) => {
    for (const r of rows) stmt.run(id, r.date, r.value);
  })(points);

  try {
    await backfillHistory();
  } catch (err) {
    console.error('[properties] backfill after bulk import failed:', err);
  }
  res.json(listHistory(id));
});

export default router;
