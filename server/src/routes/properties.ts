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
  const { value, mortgage_balance } = req.body as { value?: number; mortgage_balance?: number };
  const db = getDb();
  if (value !== undefined) {
    db.prepare(`UPDATE properties SET zestimate = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(value, Number(req.params.id));
  }
  if (mortgage_balance !== undefined) {
    db.prepare(`UPDATE properties SET mortgage_balance = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(mortgage_balance, Number(req.params.id));
  }
  takeSnapshot();
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(Number(req.params.id)));
});

router.delete('/:id', (req: Request, res: Response) => {
  removeProperty(Number(req.params.id));
  takeSnapshot();
  res.json({ success: true });
});

export default router;
