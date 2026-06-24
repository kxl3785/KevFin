import { Router, type Request, type Response } from 'express';
import { getAllocation, ASSET_CLASSES } from '../services/allocation.js';
import { getDb } from '../db/schema.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllocation());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'allocation failed' });
  }
});

// Persist whether a property (e.g. the primary residence) is excluded from the
// asset-allocation view. Does not touch net worth.
router.put('/property-exclusion', (req: Request, res: Response) => {
  const id = Number(req.body?.id);
  const excluded = req.body?.excluded ? 1 : 0;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  getDb().prepare('UPDATE properties SET excluded_from_allocation = ? WHERE id = ?').run(excluded, id);
  res.json({ ok: true });
});

// Set or clear a holding's manual asset-class override. An empty/“auto”
// assetClass removes the override and reverts to automatic classification.
router.put('/classification', (req: Request, res: Response) => {
  const symbol = String(req.body?.symbol ?? '').trim();
  const assetClass = String(req.body?.assetClass ?? '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const db = getDb();
  if (!assetClass || assetClass === 'auto') {
    db.prepare('DELETE FROM asset_class_overrides WHERE symbol = ?').run(symbol);
    return res.json({ ok: true, cleared: true });
  }
  if (!(ASSET_CLASSES as readonly string[]).includes(assetClass)) {
    return res.status(400).json({ error: 'invalid asset class' });
  }
  db.prepare(`
    INSERT INTO asset_class_overrides (symbol, asset_class) VALUES (?, ?)
    ON CONFLICT(symbol) DO UPDATE SET asset_class = excluded.asset_class, updated_at = datetime('now')
  `).run(symbol, assetClass);
  res.json({ ok: true });
});

export default router;
