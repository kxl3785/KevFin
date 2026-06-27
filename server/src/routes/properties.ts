import { Router, type Request, type Response } from 'express';
import { addProperty, removeProperty, fetchZestimate } from '../services/zillow.js';
import { takeSnapshot } from '../services/netWorth.js';
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

  const zestimate = await fetchZestimate(address);
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
  };
  for (const [key, col] of Object.entries(cols)) {
    if (body[key] !== undefined) {
      db.prepare(`UPDATE properties SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(body[key] as number | string | null, id);
    }
  }

  takeSnapshot(); // recomputes amortized balances + re-snapshots net worth
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(id));
});

router.delete('/:id', (req: Request, res: Response) => {
  removeProperty(Number(req.params.id));
  takeSnapshot();
  res.json({ success: true });
});

export default router;
