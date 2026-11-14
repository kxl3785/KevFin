import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { HELP_DOCS } from '../generated/helpDocs.js';

// The status reads row counts, which opens the database. db/schema.ts fixes its
// path at import time, so point it at a throwaway file BEFORE those modules load
// (hence the dynamic imports) — a test must never open data/kevfin.db.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'kevfin-setuphelp-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
const { HELP_DIR, SETUP_STATUS_FILE, runMode, setupInstructions, writeSetupHelp, buildSetupStatus } = await import('./setupHelp.js');
const { systemPrompt } = await import('./assistant.js');
const { DB_PATH } = await import('../db/schema.js');
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const info = { binaryFound: true, loggedIn: null, model: 'claude-test', minClaudeCodeVersion: '2.1.280' };

describe('bundled guides', () => {
  it('include every guide with real content', () => {
    expect(HELP_DOCS.map(d => d.file)).toEqual([
      'getting-started.md', 'desktop-app.md', 'docker.md', 'synology-portainer.md', 'advanced.md', 'environment-variables.txt',
    ]);
    for (const d of HELP_DOCS) {
      expect(d.text.length, d.file).toBeGreaterThan(400);
      expect(d.text, d.file).not.toMatch(/<img|!\[/); // screenshots are stripped
    }
    const start = HELP_DOCS[0].text;
    expect(start).toContain('SimpleFIN');
    expect(start).toContain('Restore from backup');
    expect(HELP_DOCS.find(d => d.file === 'environment-variables.txt')!.text).toContain('KEVFIN_ALLOWED_HOSTS');
  });

  // The module is generated from the Markdown guides. Editing a guide without
  // regenerating would leave the assistant quoting stale steps, so fail here.
  // Skipped where the repo root is absent (the Setup → Tests panel inside the
  // Docker image ships server/ only).
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const script = path.join(repoRoot, 'scripts/gen-help-docs.mjs');
  it.skipIf(!existsSync(script) || !existsSync(path.join(repoRoot, 'README.md')))('are in sync with the Markdown sources', () => {
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('test isolation', () => {
  it('uses a throwaway database', () => {
    expect(DB_PATH).toBe(path.join(TMP, 'test.db'));
    expect(DB_PATH).not.toContain('kevfin.db');
  });
});

describe('runMode', () => {
  it('tells the desktop app, a container and a source checkout apart', () => {
    expect(runMode({ ELECTRON_RUN_AS_NODE: '1' }, false)).toBe('desktop app');
    expect(runMode({}, true)).toBe('Docker container');
    expect(runMode({}, false)).toBe('from source');
    // The compose files set KEVFIN_ENV_PATH as well, so it must not read as the desktop app.
    expect(runMode({ KEVFIN_ENV_PATH: '/app/data/kevfin.env' }, true)).toBe('Docker container');
    expect(runMode({ KEVFIN_ENV_PATH: '/x/keys.env' }, false)).toBe('from source');
  });
});

describe('setup status and help files', () => {
  const saved = { ...process.env };
  let dir = '';
  afterEach(() => {
    process.env = { ...saved };
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('describes the installation with flags only, never a secret', () => {
    process.env.PLAID_CLIENT_ID = 'client-id-SECRETSECRET';
    process.env.PLAID_SECRET = 'plaid-SECRETSECRET';
    process.env.OPENWEBNINJA_KEY = 'own-SECRETSECRET';
    process.env.APILLOW_KEY = '';
    process.env.SEC_CONTACT_EMAIL = 'someone@example.com';
    process.env.KEVFIN_ALLOWED_HOSTS = 'kevfin.example.com, nas.example.com';
    const status = buildSetupStatus(info) as Record<string, any>;
    const text = JSON.stringify(status);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('someone@example.com');
    expect(status.configured.plaidKeys).toBe(true);
    expect(status.configured.propertyValueKeys).toEqual({ openWebNinja: true, apillow: false });
    expect(status.configured.secContactEmail).toBe(true);
    expect(status.extraAllowedHostnames).toEqual(['kevfin.example.com', 'nas.example.com']);
    expect(status.assistant).toEqual({ claudeCodeFound: true, loggedIn: null, model: 'claude-test', minimumClaudeCodeVersion: '2.1.280' });
    expect(typeof status.version).toBe('string');
    expect(status.rowCounts).toHaveProperty('connections');
  });

  it('writes the guides and the status file where the sandboxed Read can reach them', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kevfin-help-test-'));
    const files = writeSetupHelp(dir, info);
    expect(files.map(f => f.name)).toEqual([...HELP_DOCS.map(d => `${HELP_DIR}/${d.file}`), SETUP_STATUS_FILE]);
    expect(readdirSync(path.join(dir, HELP_DIR)).sort()).toEqual(HELP_DOCS.map(d => d.file).sort());
    expect(readFileSync(path.join(dir, HELP_DIR, 'getting-started.md'), 'utf8')).toBe(HELP_DOCS[0].text);
    expect(JSON.parse(readFileSync(path.join(dir, SETUP_STATUS_FILE), 'utf8')).assistant.model).toBe('claude-test');
    for (const f of files) expect(f.desc.length).toBeGreaterThan(20);
  });
});

describe('setup instructions in the chat prompt', () => {
  const text = setupInstructions();
  it('points at the guides and the status file by name', () => {
    expect(text).toContain(`${HELP_DIR}/ folder`);
    expect(text).toContain(SETUP_STATUS_FILE);
    expect(text).toMatch(/Read the relevant guide before answering/);
  });
  it('keeps the assistant from guessing, acting or collecting secrets', () => {
    expect(text).toMatch(/say so plainly instead of guessing/);
    expect(text).toMatch(/You cannot run commands, edit files or change settings/);
    expect(text).toMatch(/Never ask the user to paste a password, setup token, access token or API key/);
    expect(text).toMatch(/download a backup first/);
  });
  it('is part of every chat prompt', () => {
    expect(systemPrompt('ctx')).toContain('# Installing and setting up KevFin');
    expect(systemPrompt('ctx', '', { reportOpen: true })).toContain('# Installing and setting up KevFin');
  });
});

describe('sign-in check and model label', async () => {
  const { parseAuthStatus, probeSignedOut, getAuthStatus, resetAuthStatus, markLoggedIn, modelLabel, findClaudeBinary } = await import('./assistant.js');

  it('names the model the way people say it', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelLabel('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelLabel('claude-haiku-5-5-20260101')).toBe('Claude Haiku 5.5');
    expect(modelLabel('claude-fable-5-2')).toBe('Claude Fable 5.2');
    expect(modelLabel()).toMatch(/^Claude [A-Z][a-z]+ \d/);
  });

  it('reads the status JSON and ignores anything else', () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toBe(false);
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token"}')).toBe(true);
    expect(parseAuthStatus('error: unknown command')).toBeNull();
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toBeNull();
    expect(parseAuthStatus('')).toBeNull();
  });

  // Needs a resolvable binary (the probe does nothing without one); the fake exec
  // means the real binary is never run.
  it.skipIf(!findClaudeBinary())('only ever concludes "signed out", never "signed in"', async () => {
    const calls: string[][] = [];
    const says = (out: string) => async (_bin: string, args: string[]) => { calls.push(args); return out; };

    resetAuthStatus();
    await probeSignedOut(true, says('{"loggedIn":true}'));
    expect(getAuthStatus().loggedIn).toBeNull();          // credentials exist ≠ they work
    expect(calls[0]).toEqual(['auth', 'status', '--json']);

    await probeSignedOut(true, says('not json'));
    expect(getAuthStatus().loggedIn).toBeNull();

    await probeSignedOut(true, says('{"loggedIn":false}'));
    expect(getAuthStatus().loggedIn).toBe(false);
    expect(getAuthStatus().command).toBeTruthy();         // the gate gets the command to run

    // A real call's result is never overridden by an unforced probe.
    markLoggedIn();
    const before = calls.length;
    await probeSignedOut(false, says('{"loggedIn":false}'));
    expect(getAuthStatus().loggedIn).toBe(true);
    expect(calls.length).toBe(before);

    await probeSignedOut(true, async () => { throw new Error('spawn failed'); });
    expect(getAuthStatus().loggedIn).toBe(true);
    resetAuthStatus();
  });
});
