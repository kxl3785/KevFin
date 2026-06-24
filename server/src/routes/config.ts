import { Router, type Request, type Response } from 'express';
import { getKeyStatus, savePlaidKeys, KeyError } from '../services/keys.js';

const router = Router();

// Current key status — booleans + masked hints only. Never returns a secret.
router.get('/keys', (_req: Request, res: Response) => {
  res.json(getKeyStatus());
});

// Set/replace the Plaid credentials. They're validated with a live test call
// before being persisted to server/.env; on success the change applies without
// a restart.
router.post('/keys', async (req: Request, res: Response) => {
  const body = req.body as {
    plaid_client_id?: string;
    plaid_secret?: string;
    plaid_env?: string;
  };

  const hasPlaid = ['plaid_client_id', 'plaid_secret', 'plaid_env']
    .some(k => typeof (body as Record<string, unknown>)[k] === 'string' && (body as Record<string, string>)[k].trim() !== '');

  if (!hasPlaid) {
    return res.status(400).json({ error: 'No credentials provided.' });
  }

  try {
    await savePlaidKeys({ clientId: body.plaid_client_id, secret: body.plaid_secret, env: body.plaid_env });
    res.json(getKeyStatus());
  } catch (e) {
    if (e instanceof KeyError) return res.status(422).json({ error: e.message });
    console.error('[config] saving keys failed:', e);
    res.status(500).json({ error: 'Could not save the credentials.' });
  }
});

export default router;
