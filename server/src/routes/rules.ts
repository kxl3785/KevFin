import { Router, type Request, type Response } from 'express';
import { getRulesReview, updateRuleCategory, deleteRule, bulkUpdateRules, type RuleMutation } from '../services/rulesReview.js';

// Mounted at /api/budget/rules — the rules review (what each categorization rule
// decides) plus editing/removing individual rules or a selection of them.
// Creating a rule still goes through PUT /api/budget/rule.
const router = Router();

// Positive integer path param, else null.
const parseId = (raw: string): number | null => (/^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null);
const reply = (res: Response, r: RuleMutation) => (r.ok ? res.json({ success: true }) : res.status(r.status).json({ error: r.error }));

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getRulesReview());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'rules review failed' });
  }
});

// Change the category of, or delete, several rules at once (all or nothing).
// Body: { ids: number[], action: 'delete' } or { ids, action: 'category', category }.
router.post('/bulk', (req: Request, res: Response) => {
  const { ids, action, category } = (req.body ?? {}) as { ids?: unknown; action?: unknown; category?: unknown };
  if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(id) && (id as number) > 0)) {
    return res.status(400).json({ error: 'ids must be a list of rule ids' });
  }
  if (action !== 'delete' && action !== 'category') return res.status(400).json({ error: 'action must be delete or category' });
  if (action === 'category' && (typeof category !== 'string' || !category.trim())) return res.status(400).json({ error: 'category required' });
  try {
    const r = bulkUpdateRules(ids as number[], action, typeof category === 'string' ? category : undefined);
    if (r.ok) res.json({ success: true, count: r.count });
    else res.status(r.status).json({ error: r.error });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'bulk rule update failed' });
  }
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid rule id' });
  const { category } = (req.body ?? {}) as { category?: unknown };
  if (typeof category !== 'string' || !category.trim()) return res.status(400).json({ error: 'category required' });
  try {
    reply(res, updateRuleCategory(id, category));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'rule update failed' });
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid rule id' });
  try {
    reply(res, deleteRule(id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'rule delete failed' });
  }
});

export default router;
