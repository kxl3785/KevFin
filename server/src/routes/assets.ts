import { Router, type Request, type Response } from 'express';
import { takeSnapshot } from '../services/netWorth.js';
import { CATEGORIES, type Category } from '../util/categorize.js';
import { getDb } from '../db/schema.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM manual_assets ORDER BY name').all());
});

router.post('/', (req: Request, res: Response) => {
  const { name, value, category, interest_rate } = req.body as {
    name?: string;
    value?: number;
    category?: Category;
    interest_rate?: number | null;
  };
  if (!name) return res.status(400).json({ error: 'name required' });
  const cat = category && CATEGORIES.includes(category) ? category : 'other';
  // null/undefined → no rate (legacy investment-pool behavior in the Forecast).
  const rate = interest_rate == null || Number.isNaN(interest_rate) ? null : interest_rate;

  const db = getDb();
  const info = db
    .prepare('INSERT INTO manual_assets (name, category, value, interest_rate) VALUES (?, ?, ?, ?)')
    .run(name, cat, value ?? 0, rate);
  takeSnapshot();
  res.json(db.prepare('SELECT * FROM manual_assets WHERE id = ?').get(Number(info.lastInsertRowid)));
});

router.patch('/:id', (req: Request, res: Response) => {
  const { name, value, category, interest_rate } = req.body as {
    name?: string;
    value?: number;
    category?: Category;
    interest_rate?: number | null;
  };
  const db = getDb();
  if (name !== undefined)
    db.prepare(`UPDATE manual_assets SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(name, req.params.id);
  if (value !== undefined)
    db.prepare(`UPDATE manual_assets SET value = ?, updated_at = datetime('now') WHERE id = ?`).run(value, req.params.id);
  if (category !== undefined && CATEGORIES.includes(category))
    db.prepare(`UPDATE manual_assets SET category = ?, updated_at = datetime('now') WHERE id = ?`).run(category, req.params.id);
  // Explicit null clears the rate (back to the legacy investment-pool behavior).
  if (interest_rate !== undefined) {
    const rate = interest_rate == null || Number.isNaN(interest_rate) ? null : interest_rate;
    db.prepare(`UPDATE manual_assets SET interest_rate = ?, updated_at = datetime('now') WHERE id = ?`).run(rate, req.params.id);
  }

  takeSnapshot();
  res.json(db.prepare('SELECT * FROM manual_assets WHERE id = ?').get(Number(req.params.id)));
});

router.delete('/:id', (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM manual_assets WHERE id = ?').run(req.params.id);
  takeSnapshot();
  res.json({ success: true });
});

export default router;
