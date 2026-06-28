import { Router, type Request, type Response } from 'express';
import { getRecurringPayload, addRecurring, removeRecurring, setRecurringAmount, clearRecurringAmount } from '../services/recurring.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getRecurringPayload());
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
    res.json(await getRecurringPayload());
  } catch (err) {
    console.error('[recurring:add]', err);
    res.status(500).json({ error: 'add failed' });
  }
});

// Edit an item's monthly amount (override the detected average).
router.put('/:merchant/amount', async (req: Request, res: Response) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    setRecurringAmount(req.params.merchant, amount);
    res.json(await getRecurringPayload());
  } catch (err) {
    console.error('[recurring:amount]', err);
    res.status(500).json({ error: 'edit failed' });
  }
});

// Reset an item's amount back to the detected value (clear the override).
router.delete('/:merchant/amount', async (req: Request, res: Response) => {
  try {
    clearRecurringAmount(req.params.merchant);
    res.json(await getRecurringPayload());
  } catch (err) {
    console.error('[recurring:amount:reset]', err);
    res.status(500).json({ error: 'reset failed' });
  }
});

// Remove an item — deletes a manual one, or hides an auto-detected one.
router.delete('/:merchant', async (req: Request, res: Response) => {
  try {
    removeRecurring(req.params.merchant);
    res.json(await getRecurringPayload());
  } catch (err) {
    console.error('[recurring:remove]', err);
    res.status(500).json({ error: 'remove failed' });
  }
});

export default router;
