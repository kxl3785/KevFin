import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// The AI assistant's on/off switch has to hold on the server: with it off, no
// route may gather data for Claude or start a model run, whatever the browser
// sends. Throwaway database; the path is fixed when db/schema.ts loads.
const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-switch-'));
process.env.DB_PATH = path.join(TMP, 'switch.db');
delete process.env.KEVFIN_ASSISTANT;

const { getDb } = await import('../db/schema.js');
const { isAssistantEnabled, setAssistantEnabled, getSystemStatus } = await import('./data.js');
const { advisoryAllowed } = await import('./report.js');
const { default: express } = await import('express');
const { default: assistantRouter, ASSISTANT_OFF_MESSAGE } = await import('../routes/assistant.js');
const { default: dataRouter } = await import('../routes/data.js');

let server: import('http').Server;
let base = '';
const post = (route: string, body: unknown) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const forget = () => getDb().prepare(`DELETE FROM meta WHERE key = 'assistant_enabled'`).run();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', assistantRouter);
  app.use('/api/data', dataRouter);
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterEach(() => { forget(); delete process.env.KEVFIN_ASSISTANT; delete process.env.KEVFIN_REPORT_NO_AI; });
afterAll(() => { server?.close(); rmSync(TMP, { recursive: true, force: true }); });

describe('the stored setting', () => {
  it('is on by default, as before the switch existed', () => {
    expect(isAssistantEnabled()).toBe(true);
    expect(getSystemStatus().assistantEnabled).toBe(true);
  });
  it('can be shipped off with KEVFIN_ASSISTANT, until the switch is used', () => {
    for (const v of ['off', 'false', '0', 'no', 'OFF']) { process.env.KEVFIN_ASSISTANT = v; expect(isAssistantEnabled(), v).toBe(false); }
    process.env.KEVFIN_ASSISTANT = 'on';
    expect(isAssistantEnabled()).toBe(true);
    process.env.KEVFIN_ASSISTANT = 'off';
    setAssistantEnabled(true);
    expect(isAssistantEnabled()).toBe(true); // the saved choice wins
    setAssistantEnabled(false);
    delete process.env.KEVFIN_ASSISTANT;
    expect(isAssistantEnabled()).toBe(false);
  });
});

describe('POST /api/data/assistant', () => {
  it('turns it off and on again', async () => {
    let r = await post('/data/assistant', { enabled: false });
    expect(await r.json()).toEqual({ ok: true, enabled: false });
    expect(isAssistantEnabled()).toBe(false);
    r = await post('/data/assistant', { enabled: true });
    expect(r.status).toBe(200);
    expect(isAssistantEnabled()).toBe(true);
  });
  it('accepts only a real boolean, so nothing switches it on by accident', async () => {
    setAssistantEnabled(false);
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
      const r = await post('/data/assistant', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(isAssistantEnabled()).toBe(false);
  });
});

describe('with the assistant off', () => {
  it('chat and document import are refused before anything runs', async () => {
    setAssistantEnabled(false);
    const chat = await post('/assistant/chat', { messages: [{ role: 'user', content: 'What is my net worth?' }] });
    expect(chat.status).toBe(403);
    expect(await chat.json()).toEqual({ error: ASSISTANT_OFF_MESSAGE, disabled: true });
    const ingest = await post('/assistant/ingest', { filename: 'statement.pdf', dataBase64: 'AAAA' });
    expect(ingest.status).toBe(403);
    expect((await ingest.json()).disabled).toBe(true);
  });
  it('the status says so without checking the sign-in', async () => {
    setAssistantEnabled(false);
    const r = await fetch(`${base}/assistant/status`);
    const d = await r.json();
    expect(d.enabled).toBe(false);
    expect(d.loggedIn).toBeNull();
    expect(typeof d.modelLabel).toBe('string');
  });
  it('the quarterly report gets no AI commentary', () => {
    setAssistantEnabled(false);
    expect(advisoryAllowed()).toBe(false);
    setAssistantEnabled(true);
    expect(advisoryAllowed()).toBe(true);
    process.env.KEVFIN_REPORT_NO_AI = '1';
    expect(advisoryAllowed()).toBe(false);
  });
});

describe('with the assistant on', () => {
  it('the routes are not blocked by the switch', async () => {
    setAssistantEnabled(true);
    // An empty conversation is rejected for its own reasons (400, or 503 where
    // Claude Code is not installed) — never with the switched-off response.
    const chat = await post('/assistant/chat', { messages: [] });
    expect(chat.status).not.toBe(403);
    expect((await chat.json()).disabled).toBeUndefined();
    const ingest = await post('/assistant/ingest', {});
    expect(ingest.status).toBe(400);
  });
});
