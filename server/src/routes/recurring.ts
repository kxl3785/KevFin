import { Router, type Request, type Response } from 'express';
import { getRecurring } from '../services/recurring.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getRecurring());
  } catch (err) {
    console.error('[recurring]', err);
    res.status(500).json({ error: 'recurring failed' });
  }
});

export default router;
