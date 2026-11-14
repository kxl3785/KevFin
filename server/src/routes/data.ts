import { Router, type Request, type Response } from 'express';
import express from 'express';
import { createReadStream } from 'fs';
import { rm } from 'fs/promises';
import {
  backupToTempFile, backupFilename, restoreFromBuffer, RestoreError,
  resetData, getSystemStatus, setDailySnapshotEnabled, setAssistantEnabled, type ResetMode,
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
    const file = tmp;
    const stream = createReadStream(file);
    // The temp copy holds every provider token, so it must never outlive the
    // request. 'close' on the response fires for a finished download AND an aborted
    // one; pipe() doesn't destroy the source when the client goes away, so do it
    // ourselves and then delete the file.
    const cleanup = () => { stream.destroy(); rm(file, { force: true }).catch(() => {}); };
    res.on('close', cleanup);
    // pipe() doesn't forward errors — without a handler a mid-stream I/O error
    // is an uncaught 'error' event that kills the process.
    stream.on('error', err => {
      console.error('[data] backup stream failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed.' });
      else res.destroy();
    });
    if (res.destroyed) cleanup(); // client left while the backup was being written
    else stream.pipe(res);
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

// Turn the AI assistant on or off. { enabled: boolean } — a real boolean, so a
// malformed request can never switch it on by accident.
router.post('/assistant', (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Expected { enabled: true | false }.' });
  setAssistantEnabled(req.body.enabled);
  res.json({ ok: true, enabled: req.body.enabled });
});

export default router;
