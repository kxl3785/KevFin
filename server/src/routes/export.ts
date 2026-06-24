import { Router, type Request, type Response } from 'express';
import { exportSnapshotHtml } from '../services/export.js';

const router = Router();

// Generate a password-protected, self-contained HTML snapshot of all current
// data. The password is used only to encrypt the payload in-memory — it is
// never stored. The response is the HTML file the client downloads.
router.post('/snapshot', async (req: Request, res: Response) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  // Optional soft-expiry date (YYYY-MM-DD). Stored inside the encrypted payload;
  // the viewer refuses to render past it. Empty/absent = never expires.
  let expiresAt: string | null = null;
  const raw = req.body?.expiresAt;
  if (typeof raw === 'string' && raw.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
      return res.status(400).json({ error: 'expiresAt must be YYYY-MM-DD.' });
    }
    // End of the given day, local time, so it stays viewable through that date.
    expiresAt = new Date(raw.trim() + 'T23:59:59').toISOString();
  }

  try {
    const html = await exportSnapshotHtml(password, expiresAt);
    const filename = `kevfin-snapshot-${new Date().toISOString().slice(0, 10)}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (err) {
    console.error('[export] snapshot failed:', err);
    res.status(500).json({ error: 'Snapshot export failed.' });
  }
});

export default router;
