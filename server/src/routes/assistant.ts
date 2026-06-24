import { Router, type Request, type Response } from 'express';
import { spawn } from 'child_process';
import os from 'os';
import { findClaudeBinary, buildFinancialContext, systemPrompt } from '../services/assistant.js';
import { extractFromDocument, commitProposals, IngestError } from '../services/ingest.js';

const router = Router();

interface ChatMessage { role: 'user' | 'assistant'; content: string }

// --- Plan usage-limit gate -------------------------------------------------
// Queries run on the user's Claude subscription, which has usage limits. When a
// query hits one, the binary tells us (often with a reset time). We record it
// and refuse further queries until then, so the app never keeps firing requests
// against a limit that's already been reached.
let usageLimitedUntil = 0; // epoch ms; 0 = not currently limited
const UNKNOWN_RESET_COOLDOWN_MS = 10 * 60_000; // wait this long to re-check when no reset time was given

// Detect a usage/rate-limit error and the time it resets. Claude Code commonly
// appends the reset as a trailing unix epoch, e.g. "usage limit reached|1719500400".
function parseUsageLimit(result: string): number | null {
  if (!/usage limit|rate limit|limit reached|too many requests/i.test(result)) return null;
  const m = result.match(/\|\s*(\d{9,13})\s*$/);
  if (m) {
    const n = Number(m[1]);
    return n > 1e12 ? n : n * 1000; // tolerate seconds or milliseconds
  }
  return Date.now() + UNKNOWN_RESET_COOLDOWN_MS; // no reset given — back off, then re-check
}

function usageLimitMessage(resetMs: number): string {
  const when = new Date(resetMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `You've reached your Claude plan's usage limit, so I've paused queries to avoid exceeding it. Try again after ${when}.`;
}

// Chat endpoint. Drives the local Claude Code binary in headless print mode —
// so it runs on the user's existing Claude login rather than a paid API key.
// The reply is delivered as a single SSE message once the model finishes (the
// UI shows "Thinking…" until then); the SSE shape lets us also report errors.
router.post('/chat', async (req: Request, res: Response) => {
  const bin = findClaudeBinary();
  if (!bin) {
    return res.status(503).json({
      error: 'Claude Code was not found on this machine. Install it (or set CLAUDE_BIN in server/.env) to use the assistant.',
    });
  }

  const incoming: ChatMessage[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = incoming
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Expected a non-empty conversation ending in a user message.' });
  }

  // Don't even spawn a query while the plan's usage limit is in effect.
  if (usageLimitedUntil > Date.now()) {
    return res.status(429).json({ error: usageLimitMessage(usageLimitedUntil) });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Heartbeat so nothing between us and the browser times out while the model
  // is still cold-starting / thinking (no output is emitted during that window).
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  const context = await buildFinancialContext();

  // -p takes a single prompt, so flatten the conversation into one transcript.
  const prompt = messages.length === 1
    ? messages[0].content
    : messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') +
      '\n\nReply to the most recent user message.';

  const child = spawn(bin, [
    '-p', prompt,
    '--model', 'claude-opus-4-8',
    '--system-prompt', systemPrompt(context),
    '--allowedTools', 'none',          // answer from the prompt only — no tool/file access
    '--output-format', 'json',         // one result object, delivered when complete
  ], { cwd: os.tmpdir(), env: process.env });

  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

  child.on('error', err => {
    clearInterval(heartbeat);
    console.error('[assistant] spawn failed:', err);
    send('error', { message: 'Could not start Claude Code.' });
    res.end();
  });

  child.on('close', () => {
    clearInterval(heartbeat);
    let result = '';
    let isError = true; // assume failure until we parse a clean success object
    try {
      const obj = JSON.parse(stdout.trim());
      result = typeof obj.result === 'string' ? obj.result : '';
      isError = !!obj.is_error;
    } catch (e) {
      console.error('[assistant] could not parse output:', e);
    }

    const resetMs = isError ? parseUsageLimit(result) : null;
    if (resetMs) {
      usageLimitedUntil = resetMs;
      send('error', { message: usageLimitMessage(resetMs) });
    } else if (isError) {
      const loggedOut = /not logged in|\/login/i.test(result);
      send('error', {
        message: loggedOut
          ? 'Claude Code isn’t logged in. Open Claude Code, run /login and choose your subscription, then try again.'
          : (result || 'The assistant request failed.'),
      });
    } else {
      usageLimitedUntil = 0; // healthy response — clear any prior limit gate
      if (result) send('delta', result);
      send('done', {});
    }
    res.end();
  });

  // Stop generating (and stop billing your subscription) if the user navigates away.
  req.on('close', () => { clearInterval(heartbeat); child.kill(); });
});

// --- Document upload -------------------------------------------------------
// Read an uploaded financial document and return *proposed* entries for the
// user to review. The file is processed in a temp dir and deleted immediately
// (see services/ingest.ts) — nothing about the document is retained. No data is
// written to the database here; that only happens on an explicit /ingest/commit.
router.post('/ingest', async (req: Request, res: Response) => {
  const { filename, dataBase64 } = req.body as { filename?: string; dataBase64?: string };
  if (typeof filename !== 'string' || typeof dataBase64 !== 'string' || !dataBase64) {
    return res.status(400).json({ error: 'Expected { filename, dataBase64 }.' });
  }

  if (usageLimitedUntil > Date.now()) {
    return res.status(429).json({ error: usageLimitMessage(usageLimitedUntil) });
  }

  try {
    const result = await extractFromDocument({ filename, dataBase64 });
    usageLimitedUntil = 0; // healthy response clears any prior limit gate
    res.json(result);
  } catch (e) {
    if (e instanceof IngestError && e.usageLimited) {
      usageLimitedUntil = Date.now() + UNKNOWN_RESET_COOLDOWN_MS;
      return res.status(429).json({ error: e.message });
    }
    const msg = e instanceof IngestError ? e.message : 'The document could not be processed.';
    if (!(e instanceof IngestError)) console.error('[assistant] ingest failed:', e);
    res.status(e instanceof IngestError ? 422 : 500).json({ error: msg });
  }
});

// Persist the entries the user confirmed (and possibly edited) from /ingest.
router.post('/ingest/commit', (req: Request, res: Response) => {
  const proposals = req.body?.proposals;
  if (!Array.isArray(proposals)) {
    return res.status(400).json({ error: 'Expected { proposals: [...] }.' });
  }
  try {
    res.json(commitProposals(proposals));
  } catch (e) {
    const msg = e instanceof IngestError ? e.message : 'Could not save those entries.';
    if (!(e instanceof IngestError)) console.error('[assistant] ingest commit failed:', e);
    res.status(e instanceof IngestError ? 422 : 500).json({ error: msg });
  }
});

export default router;
