import { Router, type Request, type Response } from 'express';
import { claimSetupToken } from '../services/simplefin.js';
import { takeSnapshot } from '../services/netWorth.js';
import { CATEGORIES, type Category } from '../util/categorize.js';
import { getDb } from '../db/schema.js';

const router = Router();

// Connect a new institution set by claiming a SimpleFIN setup token.
router.post('/claim', async (req: Request, res: Response) => {
  const { setup_token } = req.body as { setup_token?: string };
  if (!setup_token) return res.status(400).json({ error: 'setup_token required' });

  try {
    await claimSetupToken(setup_token);
    takeSnapshot();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to claim token' });
  }
});

// List connections with how many accounts each one exposes.
router.get('/connections', (_req: Request, res: Response) => {
  const db = getDb();
  const connections = db.prepare(`
    SELECT c.id, c.created_at,
           COUNT(a.id) AS account_count,
           COALESCE(GROUP_CONCAT(DISTINCT a.org_name), '') AS institutions
    FROM simplefin_connections c
    LEFT JOIN accounts a ON a.connection_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at
  `).all();
  res.json(connections);
});

// Override an account's category, display name, and/or hidden state.
// name: a string sets a custom name; null resets to the institution's name.
// hidden: when true, the account drops out of the list and net-worth totals.
router.patch('/accounts/:id', (req: Request, res: Response) => {
  const { category, name, hidden } = req.body as {
    category?: Category;
    name?: string | null;
    hidden?: boolean;
  };
  const db = getDb();

  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'valid category required' });
    }
    db.prepare('UPDATE accounts SET category = ? WHERE id = ?').run(category, req.params.id);
  }

  if (name !== undefined) {
    const custom = name && name.trim() ? name.trim() : null;
    db.prepare('UPDATE accounts SET custom_name = ? WHERE id = ?').run(custom, req.params.id);
  }

  if (hidden !== undefined) {
    db.prepare('UPDATE accounts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, req.params.id);
  }

  // Hiding changes the totals, so re-snapshot today.
  takeSnapshot();
  res.json({ success: true });
});

router.delete('/connections/:id', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM accounts WHERE connection_id = ?').run(req.params.id);
  db.prepare('DELETE FROM simplefin_connections WHERE id = ?').run(req.params.id);
  takeSnapshot();
  res.json({ success: true });
});

export default router;
