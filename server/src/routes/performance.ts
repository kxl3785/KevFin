import { Router, type Request, type Response } from 'express';
import { getPerformance } from '../services/performance.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const days = Math.min(1825, Math.max(30, parseInt(String(req.query.days ?? '365'), 10) || 365));
  try {
    res.json(await getPerformance(days));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'performance fetch failed' });
  }
});

export default router;
