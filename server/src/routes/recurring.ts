import { Router, type Request, type Response } from 'express';
import { getRecurring, addRecurring, removeRecurring } from '../services/recurring.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getRecurring());
  } catch (err) {
    console.error('[recurring]', err);
    res.status(500).json({ error: 'recurring failed' });
  }
});

// Add a manual recurring item (e.g. an annual bill the detector can't see yet).
router.post('/', async (req: Request, res: Response) => {
  try {
    const { payee, category, amount, isFixed } = req.body ?? {};
    if (!payee || !String(payee).trim()) return res.status(400).json({ error: 'payee required' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    // isFixed is optional — when omitted (e.g. marking a transaction recurring) the
    // service infers it from the category.
    addRecurring({ payee: String(payee), category: String(category || 'Miscellaneous'), amount: amt, isFixed: typeof isFixed === 'boolean' ? isFixed : undefined });
    res.json(await getRecurring());
  } catch (err) {
    console.error('[recurring:add]', err);
    res.status(500).json({ error: 'add failed' });
  }
});

// Remove an item — deletes a manual one, or hides an auto-detected one.
router.delete('/:merchant', async (req: Request, res: Response) => {
  try {
    removeRecurring(req.params.merchant);
    res.json(await getRecurring());
  } catch (err) {
    console.error('[recurring:remove]', err);
    res.status(500).json({ error: 'remove failed' });
  }
});

export default router;
