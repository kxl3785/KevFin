import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { runMigrations } from '../db/migrations.js';

// keys.ts resolves the env file at import time — point it at a throwaway file
// BEFORE the import so the success-path tests never touch a real keys file.
const envFile = vi.hoisted(() => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kevfin-keys-'));
  const file = require('path').join(dir, 'kevfin.env');
  process.env.KEVFIN_ENV_PATH = file;
  return file as string;
});
const dbRef = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/schema.js', () => ({ getDb: () => dbRef.db }));

import { saveClaudeToken, saveOpenWebNinjaKey, savePlaidKeys, saveSecContactEmail, getKeyStatus, KeyError } from './keys.js';
import { fetchEdgarConstituents, getLookThroughIssue } from './edgarHoldings.js';

// A line break in a value would inject extra KEY=VALUE lines into server/.env
// (e.g. CLAUDE_BIN, which the server later spawns), so it must be refused before
// anything is written. These all throw before touching process.env, the keys
// file, or the network.
describe('env value hardening', () => {
  it('rejects line breaks and NUL in single-key saves', () => {
    // The in-app test runner runs inside a configured install, where these keys
    // may already be set — so check they were left unchanged, not unset. Compare
    // as booleans: a failing toBe() would print the real secret in the results.
    const before = { claude: process.env.CLAUDE_CODE_OAUTH_TOKEN, owm: process.env.OPENWEBNINJA_KEY };
    for (const bad of ['x\nCLAUDE_BIN=/tmp/evil', 'x\r\nFOO=1', 'ab\0cd']) {
      expect(() => saveClaudeToken(bad)).toThrow(KeyError);
      expect(() => saveOpenWebNinjaKey(bad)).toThrow(KeyError);
    }
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN === before.claude, 'Claude token was modified').toBe(true);
    expect(process.env.OPENWEBNINJA_KEY === before.owm, 'OpenWebNinja key was modified').toBe(true);
  });

  it('rejects line breaks in Plaid credentials before validating them', async () => {
    await expect(savePlaidKeys({ clientId: 'id', secret: 's\nCLAUDE_BIN=/tmp/evil', env: 'sandbox' }))
      .rejects.toBeInstanceOf(KeyError);
  });
});

describe('saveSecContactEmail', () => {
  const saved = { email: process.env.SEC_CONTACT_EMAIL, ua: process.env.SEC_EDGAR_UA };
  beforeEach(() => { delete process.env.SEC_CONTACT_EMAIL; delete process.env.SEC_EDGAR_UA; });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [['SEC_CONTACT_EMAIL', saved.email], ['SEC_EDGAR_UA', saved.ua]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('rejects malformed addresses and line-break / NUL injection without changing anything', () => {
    for (const bad of ['nope', 'a@b', '@x.com', 'a b@x.com', 'a@x.com\nCLAUDE_BIN=/tmp/evil', 'a@x.com\r\nFOO=1', 'a\0@x.com', 'x@y.com, z@w.com', '<a@x.com>']) {
      expect(() => saveSecContactEmail(bad), JSON.stringify(bad)).toThrow(KeyError);
    }
    expect(process.env.SEC_CONTACT_EMAIL).toBeUndefined();
    expect(getKeyStatus().sec.email).toBeNull();
  });

  it('trims, persists to the keys file, exposes the email in full, and can clear it', () => {
    saveSecContactEmail('  Me.Name+sec@example.com\n');
    expect(process.env.SEC_CONTACT_EMAIL).toBe('Me.Name+sec@example.com');
    expect(getKeyStatus().sec).toEqual({ email: 'Me.Name+sec@example.com' });
    expect(readFileSync(envFile, 'utf8')).toContain('SEC_CONTACT_EMAIL=Me.Name+sec@example.com');

    saveSecContactEmail('');
    expect(getKeyStatus().sec.email).toBeNull();
    expect(readFileSync(envFile, 'utf8')).toMatch(/^SEC_CONTACT_EMAIL=$/m);
  });

  it('resets the memoised mapping failure so the next request retries at once', async () => {
    const db = new Database(':memory:'); runMigrations(db); dbRef.db = db;
    process.env.SEC_CONTACT_EMAIL = 'first@example.com';
    let status = 403;
    const f = vi.fn(async (url: string) => {
      if (status === 403) return { ok: false, status: 403, text: async () => '', json: async () => ({}) };
      if (url.endsWith('company_tickers_mf.json')) return { ok: true, status: 200, json: async () => ({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1, 'S000000001', 'C1', 'VXUS']] }) };
      if (url.endsWith('company_tickers.json')) return { ok: true, status: 200, json: async () => ({ '0': { cik_str: 1, ticker: 'BABA', title: 'Alibaba Group' } }) };
      if (url.includes('browse-edgar')) return { ok: true, status: 200, text: async () => 'Archives/edgar/data/1/000000000026000001/' };
      if (url.endsWith('index.json')) return { ok: true, status: 200, json: async () => ({ directory: { item: [{ name: 'primary_doc.xml', size: '100' }] } }) };
      return { ok: true, status: 200, text: async () => '<invstOrSec><name>Alibaba Group</name><pctVal>3.0</pctVal><assetCat>EC</assetCat><invCountry>CN</invCountry></invstOrSec>' };
    });
    vi.stubGlobal('fetch', f);

    expect(await fetchEdgarConstituents('VXUS')).toBeNull();
    expect(getLookThroughIssue()?.issue).toBe('blocked');
    const calls = f.mock.calls.length;
    expect(await fetchEdgarConstituents('VXUS')).toBeNull(); // memoised failure: no new request
    expect(f.mock.calls.length).toBe(calls);

    status = 200;
    saveSecContactEmail('second@example.com'); // reset → retry immediately
    expect(getLookThroughIssue()).toBeNull();
    const out = await fetchEdgarConstituents('VXUS');
    expect(out?.[0]).toMatchObject({ name: 'Alibaba Group', country: 'China' });
    expect(f.mock.calls.length).toBeGreaterThan(calls);
  });
});
