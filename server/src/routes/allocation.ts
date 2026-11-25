import { Router, type Request, type Response } from 'express';
import { getAllocation, ASSET_CLASSES } from '../services/allocation.js';
import { getDb } from '../db/schema.js';
import { getFeeCheckup } from '../services/feeCheckup.js';
import { setExpenseOverride } from '../services/expenseRatios.js';
import { parseExpenseRatioBody } from '../util/expenseRatio.js';
import { parseProfileBody, setHoldingProfile } from '../services/holdingProfiles.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await getAllocation({ estimate: req.query.estimate === '1' }));
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

// Set or clear a holding's manual cost-basis override (keyed by the same
// holdingId as classification — display symbol, or name when untickered). A
// null/empty value clears the override and reverts to the derived basis.
router.put('/cost-basis', (req: Request, res: Response) => {
  const symbol = String(req.body?.symbol ?? '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const db = getDb();
  const raw = req.body?.costBasis;
  if (raw === null || raw === undefined || raw === '') {
    db.prepare('DELETE FROM cost_basis_overrides WHERE symbol = ?').run(symbol);
    return res.json({ ok: true, cleared: true });
  }
  const cb = Number(raw);
  if (!Number.isFinite(cb) || cb < 0) return res.status(400).json({ error: 'invalid cost basis' });
  db.prepare(`
    INSERT INTO cost_basis_overrides (symbol, cost_basis) VALUES (?, ?)
    ON CONFLICT(symbol) DO UPDATE SET cost_basis = excluded.cost_basis, updated_at = datetime('now')
  `).run(symbol, cb);
  res.json({ ok: true });
});

// Fee and asset-location check-up: each fund's yearly expense ratio and cost,
// the portfolio's value-weighted ratio, and asset class × account tax type.
// Read-only. Looks up expense ratios by ticker only (cached ~30 days).
router.get('/fees', async (_req: Request, res: Response) => {
  try {
    res.json(await getFeeCheckup());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'fee check-up failed' });
  }
});

// Set or clear the user's own expense ratio for a holding (keyed by the same
// holdingId as classification). Body: { symbol, expenseRatio } with the ratio as
// a FRACTION (0.0003 = 0.03%/yr), 0 to 5%; null/empty clears it.
router.put('/expense-ratio', (req: Request, res: Response) => {
  const parsed = parseExpenseRatioBody(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  setExpenseOverride(parsed.id, parsed.ratio);
  res.json(parsed.ratio == null ? { ok: true, cleared: true } : { ok: true });
});

// Set or clear the user's description of what a holding tracks (keyed by the
// same holdingId as classification), for plan funds with no public data: one
// ticker or a mix from the plan's fact sheet. Body: { id, mix } with mix a list
// of { ticker, weight }, weight a FRACTION summing to 1; null clears it.
router.put('/holding-profile', (req: Request, res: Response) => {
  const parsed = parseProfileBody(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  setHoldingProfile(parsed.id, parsed.mix);
  res.json(parsed.mix == null ? { ok: true, cleared: true } : { ok: true, mix: parsed.mix });
});

export default router;
