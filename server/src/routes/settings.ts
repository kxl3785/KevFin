import { Router, type Request, type Response } from 'express';
import { getAllClientSettings, setClientSetting } from '../services/clientSettings.js';

const router = Router();

// Guardrail: a single client setting shouldn't be large. Forecast state (events,
// kids, contributions) is a few KB at most; this just bounds a pathological write.
const MAX_VALUE_BYTES = 256 * 1024;

// All persisted client settings as { key: rawJsonString }. The client hydrates
// localStorage from this before rendering so usePersistentState reads the synced
// value rather than a default.
router.get('/', (_req: Request, res: Response) => {
  res.json(getAllClientSettings());
});

// Upsert one setting. Body: { value: <rawJsonString> } — stored verbatim. The
// server treats the value as opaque; the browser owns its shape.
router.put('/:key', (req: Request, res: Response) => {
  const key = req.params.key;
  const value = (req.body ?? {}).value;
  if (!key) return res.status(400).json({ error: 'Missing key.' });
  if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string.' });
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return res.status(413).json({ error: 'value too large.' });
  try {
    setClientSetting(key, value);
    res.json({ ok: true });
  } catch (e) {
    console.error('[settings] saving client setting failed:', e);
    res.status(500).json({ error: 'Could not save the setting.' });
  }
});

export default router;
