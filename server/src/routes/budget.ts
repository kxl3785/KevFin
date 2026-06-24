import { Router, type Request, type Response } from 'express';
import { getBudget, getSpendingProjection, getReviewQueue, getCashFlow, getCashFlowTransactions, getTransactionsList, getCategoryGroups, getGroupNames, getCategoryLabeler, applyCategoryRule, suggestRules, countRule, applySmartRules, setTarget, setSignFlip, getActiveCategories, addCategory, renameCategory, removeCategory, setCategoryGroup, importTransactions, reconcileImported, getImported, clearImported, deleteImported, updateImportedCategory, acceptImported, getCategoryState, restoreCategoryState, resetCategoriesToDefault, type CategoryState } from '../services/budget.js';

const router = Router();

// Active categories with display labels applied (canonical → renamed).
const labeledCategories = (): string[] => {
  const lab = getCategoryLabeler();
  return getActiveCategories().map(c => lab.label(c));
};

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
// Accept (mark reviewed) imported rows — one by id, or all pending when none given.
router.post('/imported/accept', (req: Request, res: Response) => {
  const { id } = req.body as { id?: string };
  res.json({ accepted: acceptImported(id) });
});
// Recategorize and/or accept a single imported row.
router.patch('/imported/:id', (req: Request, res: Response) => {
  const { category, accepted } = req.body as { category?: string; accepted?: boolean };
  if (typeof category === 'string') updateImportedCategory(req.params.id, category);
  if (accepted) acceptImported(req.params.id);
  res.json({ success: true });
});
router.delete('/imported/:id', (req: Request, res: Response) => { deleteImported(req.params.id); res.json({ success: true }); });

// Flat transaction list for the All-transactions tab (range = 'all' or YYYY-MM).
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    res.json(await getTransactionsList(typeof req.query.range === 'string' ? req.query.range : 'all'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'transactions failed' });
  }
});

// Cash-flow Sankey (income sources → Income → groups + Savings → categories).
router.get('/cashflow', async (req: Request, res: Response) => {
  try {
    const detail = req.query.detail === '1' || req.query.detail === 'true';
    res.json(await getCashFlow(typeof req.query.range === 'string' ? req.query.range : '12m', detail));
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

// All-time queue of uncategorized expenses for the Quick-review wizard, grouped
// by merchant with ranked one-click category suggestions.
router.get('/review', async (_req: Request, res: Response) => {
  try {
    res.json(await getReviewQueue());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'review failed' });
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
    res.json({ ...(await getBudget(req.query.month as string | undefined)), categories: labeledCategories(), groups: getCategoryGroups() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'budget failed' });
  }
});

// Snapshot of all category-management state, so the manage UI can offer a
// lossless "Undo changes" (captured when the panel opens, restored on undo).
router.get('/categories/state', (_req: Request, res: Response) => res.json(getCategoryState()));
router.post('/categories/restore', (req: Request, res: Response) => {
  restoreCategoryState(req.body as CategoryState);
  res.json({ categories: labeledCategories(), groups: getCategoryGroups() });
});
// Reset the taxonomy to the built-in defaults (clears renames, removes customs).
router.post('/categories/reset', (_req: Request, res: Response) => {
  resetCategoriesToDefault();
  res.json({ categories: labeledCategories(), groups: getCategoryGroups() });
});
// The full ordered list of group names (for the reclassify dropdown).
router.get('/categories/groups', (_req: Request, res: Response) => res.json(getGroupNames()));

// Create a new category; the server auto-picks an emoji from the name. Returns
// the created (display) name so the caller can immediately assign it.
router.post('/category', (req: Request, res: Response) => {
  const { name, emoji } = req.body as { name?: string; emoji?: string };
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const created = addCategory(name, emoji);
  res.json({ created, categories: labeledCategories(), groups: getCategoryGroups() });
});

// Rename a category's display label, change its emoji and/or reclassify it into
// another group. :name is the category's canonical id (groups[].categories[].canonical).
router.patch('/category/:name', (req: Request, res: Response) => {
  const { label, emoji, group } = req.body as { label?: string; emoji?: string; group?: string };
  const name = decodeURIComponent(req.params.name);
  if (label !== undefined || emoji !== undefined) renameCategory(name, label, emoji);
  if (typeof group === 'string') setCategoryGroup(name, group);
  res.json({ categories: labeledCategories(), groups: getCategoryGroups() });
});

router.delete('/category/:name', (req: Request, res: Response) => {
  removeCategory(decodeURIComponent(req.params.name));
  res.json({ categories: labeledCategories(), groups: getCategoryGroups() });
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

// Suggest smart rules (merchant / amount / description text) for a just-categorized
// transaction, with a count of how many existing transactions each would cover.
router.post('/rule/suggest', async (req: Request, res: Response) => {
  const { merchant, payee, description, amount, category } = req.body as
    { merchant?: string; payee?: string; description?: string; amount?: number; category?: string };
  if (!merchant || !category) return res.status(400).json({ error: 'merchant and category required' });
  try {
    res.json(await suggestRules({ merchant, payee, description, amount: Number(amount) || 0, category }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'rule suggest failed' });
  }
});

// Count transactions matching an AND-combination of conditions (live as the user
// builds a rule).
router.post('/rule/count', async (req: Request, res: Response) => {
  const { base, contains, amount } = req.body as { base?: string; contains?: string; amount?: number };
  try {
    res.json(await countRule({ base, contains, amount: amount != null ? Number(amount) : undefined }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'rule count failed' });
  }
});

// Persist chosen smart rules; returns how many existing transactions they cover.
router.post('/rule/smart', async (req: Request, res: Response) => {
  const { rules } = req.body as { rules?: { base?: string | null; contains?: string | null; amount?: number | null; category: string }[] };
  if (!Array.isArray(rules) || !rules.length) return res.status(400).json({ error: 'rules required' });
  try {
    res.json(await applySmartRules(rules));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'rule apply failed' });
  }
});

// Set (or clear, with 0) a monthly budget target for a category.
router.put('/target', (req: Request, res: Response) => {
  const { category, limit, period } = req.body as { category?: string; limit?: number; period?: string };
  if (!category) return res.status(400).json({ error: 'category required' });
  setTarget(category, Number(limit) || 0, period === 'annual' ? 'annual' : 'monthly');
  res.json({ success: true });
});

// Reverse the +/- sign for a merchant (e.g. a payment that posts as a positive
// credit but is really money out). Omit `flip` to toggle. Applies to past & future.
router.put('/sign', (req: Request, res: Response) => {
  const { merchant, flip } = req.body as { merchant?: string; flip?: boolean };
  if (!merchant) return res.status(400).json({ error: 'merchant required' });
  res.json({ success: true, flipped: setSignFlip(merchant, typeof flip === 'boolean' ? flip : undefined) });
});

export default router;
