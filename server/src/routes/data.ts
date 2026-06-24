import { Router, type Request, type Response } from 'express';
import express from 'express';
import { createReadStream } from 'fs';
import { rm } from 'fs/promises';
import {
  backupToTempFile, backupFilename, restoreFromBuffer, RestoreError,
  resetData, getSystemStatus, setDailySnapshotEnabled, type ResetMode,
} from '../services/data.js';

const router = Router();

// System status: row counts, last-sync times, DB location, version, toggles.
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json(getSystemStatus());
  } catch (err) {
    console.error('[data] status failed:', err);
    res.status(500).json({ error: 'Could not read status.' });
  }
});

// Download a full backup of the live database.
router.get('/backup', async (_req: Request, res: Response) => {
  let tmp: string | null = null;
  try {
    tmp = await backupToTempFile();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`);
    const stream = createReadStream(tmp);
    stream.pipe(res);
    // Clean up the temp copy once the response is flushed (or on error).
    stream.on('close', () => { if (tmp) rm(tmp, { force: true }).catch(() => {}); });
  } catch (err) {
    console.error('[data] backup failed:', err);
    if (tmp) rm(tmp, { force: true }).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed.' });
  }
});

// Restore from an uploaded .db. Body is the raw file (application/octet-stream).
router.post('/restore', express.raw({ type: '*/*', limit: '500mb' }), async (req: Request, res: Response) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ error: 'No file received.' });
  }
  try {
    const counts = await restoreFromBuffer(buf);
    res.json({ ok: true, counts });
  } catch (err) {
    if (err instanceof RestoreError) return res.status(422).json({ error: err.message });
    console.error('[data] restore failed:', err);
    res.status(500).json({ error: 'Restore failed.' });
  }
});

// Reset data. { mode: 'history' | 'all' }. Credentials in .env are untouched.
router.post('/reset', (req: Request, res: Response) => {
  const mode = req.body?.mode as ResetMode;
  if (mode !== 'history' && mode !== 'all') {
    return res.status(400).json({ error: "mode must be 'history' or 'all'." });
  }
  try {
    res.json({ ok: true, counts: resetData(mode) });
  } catch (err) {
    console.error('[data] reset failed:', err);
    res.status(500).json({ error: 'Reset failed.' });
  }
});

// Toggle the automatic daily net-worth snapshot. { enabled: boolean }
router.post('/daily-snapshot', (req: Request, res: Response) => {
  const enabled = Boolean(req.body?.enabled);
  setDailySnapshotEnabled(enabled);
  res.json({ ok: true, enabled });
});

export default router;
