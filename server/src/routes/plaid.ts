import { Router, type Request, type Response } from 'express';
import { createLinkToken, exchangePublicToken, plaidConfigured } from '../services/plaid.js';
import { takeSnapshot } from '../services/netWorth.js';
import { getDb } from '../db/schema.js';

const router = Router();

// Lets the frontend hide the Plaid button when credentials aren't set.
router.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: plaidConfigured(), env: process.env.PLAID_ENV ?? 'sandbox' });
});

router.post('/link-token', async (_req: Request, res: Response) => {
  if (!plaidConfigured()) return res.status(400).json({ error: 'Plaid not configured' });
  try {
    res.json({ link_token: await createLinkToken('default-user') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

router.post('/exchange', async (req: Request, res: Response) => {
  const { public_token, institution_name } = req.body as {
    public_token?: string;
    institution_name?: string;
  };
  if (!public_token) return res.status(400).json({ error: 'public_token required' });
  try {
    await exchangePublicToken(public_token, institution_name ?? 'Unknown');
    takeSnapshot();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

router.get('/items', (_req: Request, res: Response) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT pi.item_id, pi.institution_name, pi.created_at,
           COUNT(a.id) AS account_count
    FROM plaid_items pi
    LEFT JOIN accounts a ON a.plaid_item_id = pi.item_id
    GROUP BY pi.item_id
  `).all());
});

router.delete('/items/:itemId', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM accounts WHERE plaid_item_id = ?').run(req.params.itemId);
  db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(req.params.itemId);
  takeSnapshot();
  res.json({ success: true });
});

export default router;
