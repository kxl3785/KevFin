import { Router, type Request, type Response } from 'express';
import { getPerformance, getSymbolSeries } from '../services/performance.js';
import { getReturns } from '../services/investmentReturns.js';

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

// Contribution-aware returns (deposits removed / money-weighted), coverage, the
// counted deposits and withdrawals, a benchmark over the same dates, and
// dividend + interest income. Read-only.
router.get('/returns', async (req: Request, res: Response) => {
  const days = Math.min(1825, Math.max(30, parseInt(String(req.query.days ?? '365'), 10) || 365));
  const benchmark = String(req.query.benchmark ?? 'SPY').toUpperCase();
  try {
    res.json(await getReturns(days, /^[A-Z]{1,6}$/.test(benchmark) ? benchmark : 'SPY'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'returns calculation failed' });
  }
});

// Validate + fetch a custom comparison ticker. Returns the normalised series, or
// 404 when the symbol has no price history (so the client can reject it).
router.get('/symbol', async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    return res.status(400).json({ error: 'Enter a valid ticker symbol.' });
  }
  try {
    const series = await getSymbolSeries(symbol);
    if (!series) return res.status(404).json({ error: `No price data found for “${symbol}”.` });
    res.json({ series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Symbol lookup failed.' });
  }
});

export default router;
