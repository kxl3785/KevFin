import { Router, type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { findClaudeBinary, buildFinancialContext, systemPrompt, exportChatData, getAuthStatus, markLoggedIn, markLoggedOut, resetAuthStatus, SANDBOXED_CLAUDE_ARGS, CLAUDE_TIMEOUT_MS } from '../services/assistant.js';
import { extractFromDocument, commitProposals, IngestError } from '../services/ingest.js';
import { saveClaudeToken, KeyError } from '../services/keys.js';

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
    .filter(m => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
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

  // Free everything tied to this turn. Registered before any await so it also runs
  // when the browser goes away mid-turn: 'close' on the response fires for a normal
  // finish AND an abort, so only an unfinished response (not writableEnded) means
  // the user left — then kill the model run instead of letting it keep generating
  // (and billing). (req 'close' is no use here: it fires as soon as the request
  // body is consumed on modern Node.)
  let child: ChildProcess | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let dir = '';
  let dirRemoved = false;
  const cleanup = () => {
    clearInterval(heartbeat);
    if (killTimer) clearTimeout(killTimer);
    if (!dir || dirRemoved) return; // dir may not exist yet if the browser left early
    dirRemoved = true;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  res.on('close', () => {
    if (!res.writableEnded) child?.kill();
    cleanup();
  });

  // From here on the SSE stream is open — a throw would otherwise become an
  // unhandled rejection (crashing the process) with the heartbeat left running.
  try {
    const context = await buildFinancialContext();
    // Export the full dataset to a private temp dir the model can Read on demand,
    // so it can answer from individual transactions / full history, not just the
    // aggregated snapshot. The dir holds only these files and is deleted after the
    // turn (cleanup() above) — nothing is retained. realpath so the cwd the binary
    // sees matches the paths it reads (macOS tmpdir is a /var -> /private/var symlink).
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kevfin-chat-')));
    // The Forecast (Monte Carlo) lives in the browser, so its inputs + computed
    // summary ride along on the request; pass them to the export for forecast.json.
    const clientForecast = req.body?.clientContext?.forecast;
    let dataFiles = '';
    try { dataFiles = await exportChatData(dir, clientForecast); } catch (e) { console.error('[assistant] data export failed:', e); }

    // The browser left while we were gathering data — don't start a query for nobody.
    if (res.destroyed) { cleanup(); return; }

    // -p takes a single prompt, so flatten the conversation into one transcript.
    const prompt = messages.length === 1
      ? messages[0].content
      : messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n') +
        '\n\nReply to the most recent user message.';

    // Isolation (see SANDBOXED_CLAUDE_ARGS): the binary can only Read files under
    // its cwd (this temp dir) — no shell, writes, network, or reads elsewhere.
    // The prompt goes over stdin so it can never be parsed as a CLI flag.
    // Ignore stderr rather than leave an unread pipe — a chatty binary would
    // fill the pipe buffer, block, and never emit 'close'.
    const proc = spawn(bin, [
      '-p',
      '--model', 'claude-opus-4-8',
      '--system-prompt', systemPrompt(context, dataFiles),
      ...SANDBOXED_CLAUDE_ARGS,
      '--output-format', 'json',         // one result object, delivered when complete
    ], { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc;
    proc.stdin!.on('error', () => { /* child exited before reading the prompt */ });
    proc.stdin!.end(prompt);

    let timedOut = false;
    killTimer = setTimeout(() => { timedOut = true; proc.kill(); }, CLAUDE_TIMEOUT_MS);

    let stdout = '';
    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    proc.on('error', err => {
      cleanup();
      console.error('[assistant] spawn failed:', err);
      send('error', { message: 'Could not start Claude Code.' });
      res.end();
    });

    proc.on('close', () => {
      cleanup();
      if (res.destroyed || res.writableEnded) return; // browser already gone (we killed the run) or 'error' already ended it
      let result = '';
      let isError = true; // assume failure until we parse a clean success object
      try {
        const obj = JSON.parse(stdout.trim());
        result = typeof obj.result === 'string' ? obj.result : '';
        isError = !!obj.is_error;
      } catch (e) {
        if (!timedOut) console.error('[assistant] could not parse output:', e);
      }

      const resetMs = isError ? parseUsageLimit(result) : null;
      if (timedOut) {
        send('error', { message: 'The assistant took too long to respond and was stopped. Try a narrower question.' });
      } else if (resetMs) {
        usageLimitedUntil = resetMs;
        send('error', { message: usageLimitMessage(resetMs) });
      } else if (isError) {
        const loggedOut = /not logged in|\/login/i.test(result);
        if (loggedOut) markLoggedOut();
        send('error', {
          message: loggedOut
            ? `Claude Code isn’t logged in. In a terminal, run "${bin}", type /login and choose your subscription, then try again.`
            : (result || 'The assistant request failed.'),
        });
      } else {
        usageLimitedUntil = 0; // healthy response — clear any prior limit gate
        markLoggedIn();        // a successful query proves we're authenticated
        if (result) send('delta', result);
        send('done', {});
      }
      res.end();
    });
  } catch (e) {
    // Anything thrown before/while spawning (e.g. buildFinancialContext, temp dir
    // creation) must end the stream with an error rather than leave the browser
    // waiting on a dead SSE.
    cleanup();
    console.error('[assistant] chat failed:', e);
    if (!res.destroyed && !res.writableEnded) {
      send('error', { message: 'The assistant request failed.' });
      res.end();
    }
  }
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
    const command = e instanceof IngestError ? e.command : undefined;
    if (!(e instanceof IngestError)) console.error('[assistant] ingest failed:', e);
    res.status(e instanceof IngestError ? 422 : 500).json({ error: msg, ...(command ? { command } : {}) });
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

// Report whether the AI features are usable up front, so the UI can show a login
// prompt before the user tries to chat or upload. `?recheck=1` forces a re-probe
// (e.g. right after the user logs in).
router.get('/status', (req: Request, res: Response) => {
  if (usageLimitedUntil > Date.now()) {
    // Usage-limited implies we were authenticated; surface that, not a login gate.
    return res.json({ binaryFound: true, loggedIn: true, usageLimited: true });
  }
  // `?recheck=1` (the gate's "I've logged in") forgets the prior result so the UI
  // proceeds and the next real call confirms.
  if (req.query.recheck === '1') resetAuthStatus();
  res.json(getAuthStatus());
});

// Open a terminal already running the Claude binary the importer uses, so the
// user can complete `/login` in one click instead of hunting for the right
// install. macOS-only (this is a local desktop app); elsewhere the UI falls back
// to showing the command to run by hand.
router.post('/login', (_req: Request, res: Response) => {
  const bin = findClaudeBinary();
  if (!bin) {
    return res.status(503).json({ error: 'Claude Code was not found on this machine.' });
  }
  if (process.platform !== 'darwin') {
    return res.status(400).json({ error: 'Open a terminal and run the shown command to log in.' });
  }
  try {
    // bin is server-resolved (not user input); single-quote it for the shell and
    // escape any stray quote defensively.
    const shellCmd = `'${bin.replace(/'/g, `'\\''`)}'`;
    const osa = `tell application "Terminal"\n  activate\n  do script "clear && ${shellCmd.replace(/"/g, '\\"')}"\nend tell`;
    spawn('osascript', ['-e', osa], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not open Terminal automatically. Run the shown command manually.' });
  }
});

// Cross-platform sign-in: save a Claude Code OAuth token (from `claude
// setup-token`) so the assistant authenticates on the user's own subscription.
// Works everywhere (unlike the macOS Terminal helper above) — the path the
// desktop app relies on.
router.post('/token', (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  try {
    saveClaudeToken(token);
    resetAuthStatus(); // forget the prior login result so the next call reconfirms
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof KeyError) return res.status(422).json({ error: e.message });
    console.error('[assistant] saving token failed:', e);
    res.status(500).json({ error: 'Could not save the token.' });
  }
});

export default router;
