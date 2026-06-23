import { Router, type Request, type Response } from 'express';
import { getAllocation } from '../services/allocation.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getAllocation());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'allocation failed' });
  }
});

export default router;
