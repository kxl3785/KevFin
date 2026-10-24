import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import exportRoutes from './export.js';

// Loopback-only: spin the router up on an ephemeral port and POST to it.
async function post(body: unknown): Promise<{ status: number; json: any }> {
  const app = express();
  app.use(express.json());
  app.use('/api/export', exportRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/export/snapshot`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('POST /snapshot expiresAt validation', () => {
  it('rejects a well-shaped but impossible date with 400 (not a thrown RangeError)', async () => {
    const r = await post({ password: 'hunter2', expiresAt: '2026-99-99' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/valid date/);
  });

  it('rejects a malformed date', async () => {
    expect((await post({ password: 'hunter2', expiresAt: 'tomorrow' })).status).toBe(400);
  });
});
