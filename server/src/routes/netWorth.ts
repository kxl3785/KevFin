import { Router, type Request, type Response } from 'express';
import { refreshAndSnapshot, getNetWorthHistory, getCurrentBreakdown, getTaxBuckets, takeSnapshot } from '../services/netWorth.js';
import { backfillHistory } from '../services/backfill.js';
import { fetchDailyCloses } from '../services/prices.js';

const router = Router();

// Historical daily closes for a comparison index/ticker (S&P 500, QQQ, etc.).
// Always fetches a fixed ~6-year window so the symbol-keyed cache is stable;
// the client slices to whatever range it's showing.
router.get('/index', async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? '').trim();
  if (!/^[\^A-Za-z0-9.\-]{1,12}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 6 * 365 * 86400_000).toISOString().slice(0, 10);
  try {
    res.json(await fetchDailyCloses(symbol, start, end));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'index fetch failed' });
  }
});

router.get('/history', (req: Request, res: Response) => {
  // Default high so the client gets the full series and filters by range locally.
  const days = parseInt(req.query.days as string) || 10000;
  res.json(getNetWorthHistory(days));
});

router.post('/backfill', async (_req: Request, res: Response) => {
  try {
    const count = await backfillHistory();
    // Refresh today's snapshot so it uses current live balances, not a stale
    // pre-backfill value that could create a jump at the right edge of the chart.
    takeSnapshot();
    res.json({ success: true, snapshots: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

router.get('/breakdown', (_req: Request, res: Response) => {
  res.json(getCurrentBreakdown());
});

// Per-account tax-bucket classification + totals, for the Forecast model.
router.get('/tax-buckets', (_req: Request, res: Response) => {
  res.json(getTaxBuckets());
});

router.post('/refresh', async (_req: Request, res: Response) => {
  try {
    await refreshAndSnapshot();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

export default router;
