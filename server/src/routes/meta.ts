import { Router, type Request, type Response } from 'express';
import { buildAssumptionsMeta } from '../util/assumptions.js';
import { getEdgarStatus } from '../services/edgarHoldings.js';

const router = Router();

// Exposes the live proxy/substitution shortcuts so the client FAQ renders the
// exact mappings the look-through engine uses (no duplicated, drift-prone list).
router.get('/assumptions', (_req: Request, res: Response) => {
  res.json(buildAssumptionsMeta());
});

// EDGAR look-through diagnostics: which funds have cached N-PORT holdings
// (count + as-of quarter), which came back empty, and recent fetch errors —
// so a stuck fund is debuggable from the browser instead of container logs.
router.get('/edgar', (_req: Request, res: Response) => {
  res.json(getEdgarStatus());
});

export default router;
