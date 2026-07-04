import { Router, type Request, type Response } from 'express';
import { getAllPrefs, setPref, deletePref } from '../services/prefs.js';

const router = Router();

// A defensive cap so a runaway client can't stuff the DB with a huge blob. UI
// preferences are small; the largest (Forecast assumptions) is a few KB.
const MAX_VALUE_BYTES = 512 * 1024;

// All stored UI preferences as { key -> raw JSON string }. The client hydrates
// its persisted state from this on load and treats it as the source of truth.
router.get('/', (_req: Request, res: Response) => {
  res.json(getAllPrefs());
});

// Upsert a single preference. Body: { value: <raw JSON string> }.
router.put('/:key', (req: Request, res: Response) => {
  const key = req.params.key;
  const value = (req.body as { value?: unknown })?.value;
  if (typeof key !== 'string' || key.length === 0 || key.length > 200 || typeof value !== 'string') {
    return res.status(400).json({ error: 'A non-empty key and a string value are required.' });
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    return res.status(413).json({ error: 'Preference value too large.' });
  }
  setPref(key, value);
  res.json({ ok: true });
});

router.delete('/:key', (req: Request, res: Response) => {
  deletePref(req.params.key);
  res.json({ ok: true });
});

export default router;
