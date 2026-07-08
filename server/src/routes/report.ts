import { Router, type Request, type Response } from 'express';
import { generateQuarterlyReport } from '../services/report.js';
import { getReportWindow } from '../util/reportWindow.js';

const router = Router();

// Whether the quarterly-report button should be shown right now, and for what
// period. The client polls this to decide whether to surface the (ephemeral)
// button — it's only "available" for a few days after each quarter closes.
router.get('/quarterly/status', (_req: Request, res: Response) => {
  const w = getReportWindow(new Date());
  res.json({
    available: w.open,
    quarterLabel: w.quarterLabel,
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    windowEndsAt: w.windowEndsAt,
  });
});

// Generate the report on demand and return it as a full HTML page (opened in a
// new tab by the client). Everything is rendered locally.
router.get('/quarterly', async (_req: Request, res: Response) => {
  try {
    const html = await generateQuarterlyReport();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    console.error('[report] quarterly generation failed:', err);
    res.status(500).json({ error: 'Report generation failed.' });
  }
});

export default router;
