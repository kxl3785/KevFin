import { Router, type Request, type Response } from 'express';
import { getPerformance, getSymbolSeries } from '../services/performance.js';

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
