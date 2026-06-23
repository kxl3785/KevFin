import { Router, type Request, type Response } from 'express';
import { buildAssumptionsMeta } from '../util/assumptions.js';

const router = Router();

// Exposes the live proxy/substitution shortcuts so the client FAQ renders the
// exact mappings the look-through engine uses (no duplicated, drift-prone list).
router.get('/assumptions', (_req: Request, res: Response) => {
  res.json(buildAssumptionsMeta());
});

export default router;
