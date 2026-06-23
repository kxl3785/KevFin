import { Router, type Request, type Response } from 'express';
import { getBudget, getSpendingProjection, getCashFlow, getCashFlowTransactions, getCategoryGroups, applyCategoryRule, setTarget, getActiveCategories, addCategory, removeCategory, importTransactions, reconcileImported, getImported, clearImported, deleteImported } from '../services/budget.js';

const router = Router();

// Upload a CSV of prior transactions (e.g. Monarch). Body is raw CSV text.
router.post('/import', async (req: Request, res: Response) => {
  const csv = typeof req.body === 'string' ? req.body : (req.body?.csv as string | undefined);
  if (!csv) return res.status(400).json({ error: 'CSV body required' });
  try {
    const result = importTransactions(csv);
    const { removed } = await reconcileImported(); // auto-remove SimpleFIN duplicates
    res.json({ ...result, reconciled: removed });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'import failed' });
  }
});

router.post('/reconcile', async (_req: Request, res: Response) => {
  try { res.json(await reconcileImported()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'reconcile failed' }); }
});

router.get('/imported', (_req: Request, res: Response) => res.json(getImported()));
router.delete('/imported', (_req: Request, res: Response) => res.json({ cleared: clearImported() }));
router.delete('/imported/:id', (req: Request, res: Response) => { deleteImported(req.params.id); res.json({ success: true }); });

// Cash-flow Sankey (income sources → Income → groups + Savings → categories).
router.get('/cashflow', async (req: Request, res: Response) => {
  try {
    res.json(await getCashFlow(typeof req.query.range === 'string' ? req.query.range : '12m'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'cashflow failed' });
  }
});

// Transactions behind a clicked Sankey node/band.
router.get('/cashflow/transactions', async (req: Request, res: Response) => {
  const s = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
  try {
    res.json(await getCashFlowTransactions(s('range') ?? '12m', s('type') ?? '', s('value')));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'cashflow transactions failed' });
  }
});

// Expense/income projection derived from historical transactions (for Forecast).
router.get('/projection', async (_req: Request, res: Response) => {
  try {
    res.json(await getSpendingProjection());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'projection failed' });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json({ ...(await getBudget(req.query.month as string | undefined)), categories: getActiveCategories(), groups: getCategoryGroups() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'budget failed' });
  }
});

router.post('/category', (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  addCategory(name);
  res.json({ categories: getActiveCategories() });
});

router.delete('/category/:name', (req: Request, res: Response) => {
  removeCategory(req.params.name);
  res.json({ categories: getActiveCategories() });
});

// Recategorize a merchant. scope 'one' = just this merchant's transactions;
// scope 'all' = also propagate to similar merchants. Returns how many OTHER
// transactions an "apply to all" covers, so the UI can estimate / offer it.
router.put('/rule', async (req: Request, res: Response) => {
  const { merchant, category, scope } = req.body as { merchant?: string; category?: string; scope?: string };
  if (!merchant || !category) return res.status(400).json({ error: 'merchant and category required' });
  try {
    const result = await applyCategoryRule(merchant, category, scope === 'all' ? 'all' : 'one');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'recategorize failed' });
  }
});

// Set (or clear, with 0) a monthly budget target for a category.
router.put('/target', (req: Request, res: Response) => {
  const { category, limit } = req.body as { category?: string; limit?: number };
  if (!category) return res.status(400).json({ error: 'category required' });
  setTarget(category, Number(limit) || 0);
  res.json({ success: true });
});

export default router;
