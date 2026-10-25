import { Router, type Request, type Response } from 'express';
import { getQuarterlyReport, getStoredReport } from '../services/reportCache.js';
import { getReportWindow } from '../util/reportWindow.js';

const router = Router();

// Whether the quarterly-report button should be shown right now, and for what
// period. The client polls this to decide whether to surface the (ephemeral)
// button — it's only "available" for a few days after each quarter closes.
// `generatedAt` is when the stored copy was built (null until first generated).
router.get('/quarterly/status', (_req: Request, res: Response) => {
  const w = getReportWindow(new Date());
  res.json({
    generatedAt: getStoredReport()?.generatedAt ?? null,
    available: w.open,
    quarterLabel: w.quarterLabel,
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    windowEndsAt: w.windowEndsAt,
  });
});

// Serve the stored report as a full HTML page (opened in a new tab by the
// client), generating it on first use. Everything is rendered locally.
router.get('/quarterly', async (_req: Request, res: Response) => {
  try {
    const { html } = await getQuarterlyReport();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    console.error('[report] quarterly generation failed:', err);
    res.status(500).json({ error: 'Report generation failed.' });
  }
});

// Rebuild the report with the latest data and commentary, replacing the stored
// copy. Can take up to ~90 s; concurrent calls share one generation.
router.post('/quarterly/regenerate', async (_req: Request, res: Response) => {
  try {
    const { generatedAt } = await getQuarterlyReport({ fresh: true });
    res.json({ generatedAt });
  } catch (err) {
    console.error('[report] quarterly regeneration failed:', err);
    res.status(500).json({ error: 'Report generation failed.' });
  }
});

export default router;
