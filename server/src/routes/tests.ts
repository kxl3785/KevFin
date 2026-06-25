import { Router, type Request, type Response } from 'express';
import { runTests, testsAvailable } from '../services/tests.js';

const router = Router();

// Whether the test runner is present (it's a dev dependency), so the Setup UI can
// show the run control or an explanatory note.
router.get('/status', (_req: Request, res: Response) => {
  res.json({ available: testsAvailable() });
});

// Run the server unit suite once and return a structured pass/fail summary.
router.post('/run', async (_req: Request, res: Response) => {
  try {
    res.json(await runTests());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Test run failed' });
  }
});

export default router;
