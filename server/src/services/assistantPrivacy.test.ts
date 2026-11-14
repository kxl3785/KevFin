import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// What the assistant is shown must not carry details it has no use for: a street
// address, or an email, phone number or long account number sitting in a
// transaction's text. Runs against a throwaway database (the path is fixed when
// db/schema.ts loads, hence the dynamic imports).
const TMP = mkdtempSync(path.join(tmpdir(), 'kevfin-privacy-'));
process.env.DB_PATH = path.join(TMP, 'privacy.db');

const { refreshConnection } = await import('./simplefin.js');
const { getDb } = await import('../db/schema.js');
const { buildFinancialContext, exportChatData, privacyInstructions, systemPrompt } = await import('./assistant.js');
const { previewAction } = await import('./assistantActions.js');

const NOW = new Date('2026-06-23T12:00:00Z');
const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);
const STREET = '742 Evergreen Terrace';
const SECRETS = [STREET, '97477', 'jane.doe@example.com', '214-555-0142', '000123456789', '4111111111111111'];

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const db = getDb();
  let seq = 0;
  const tx = (date: string, amount: number, payee: string, memo = '') =>
    ({ id: `pv-${seq++}`, posted: unix(date), amount: amount.toFixed(2), description: payee, payee, memo });
  const checking = {
    org: { name: 'Chase' }, id: 'pv-checking', name: 'Total Checking 000123456789', currency: 'USD', balance: '5000.00',
    'balance-date': unix('2026-06-23'),
    transactions: [
      tx('2026-05-02', 3000, 'ACME PAYROLL'),
      tx('2026-05-10', -150, 'Zelle payment to jane.doe@example.com', 'thanks! call 214-555-0142'),
      tx('2026-05-12', -60, 'ACH DEBIT 000123456789 CITY UTILITY'),
      tx('2026-05-14', -25, 'CARD 4111111111111111 QQ MARKET'),
      tx('2026-05-16', -8.5, 'STARBUCKS #1234'),
    ],
  };
  db.prepare('INSERT INTO simplefin_connections (id, access_url) VALUES (1, ?)').run('https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)').run('sf_cache_1', NOW.getTime(), JSON.stringify([checking]));
  await refreshConnection(1, 'https://demo:demo@bridge.example.invalid/simplefin');
  db.prepare(`INSERT INTO properties (address, zestimate, mortgage_balance) VALUES (?, 815000, 498000)`).run(`${STREET}, Springfield, OR 97477`);
});

afterAll(() => {
  vi.useRealTimers();
  rmSync(TMP, { recursive: true, force: true });
});

describe('what the assistant is shown', () => {
  it('the snapshot names the town, not the street', async () => {
    const ctx = await buildFinancialContext();
    expect(ctx).toContain('Springfield, OR: value $815,000');
    expect(ctx).toContain('Total Checking …6789');
    for (const s of SECRETS) expect(ctx, s).not.toContain(s);
  });

  it('the data files mask addresses, contact details and long numbers', async () => {
    const dir = mkdtempSync(path.join(TMP, 'chat-'));
    const list = await exportChatData(dir);
    const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
    const all = ['transactions.jsonl', 'accounts.json', 'budget.json', 'forecast.json', 'net_worth_history.jsonl']
      .map(f => { try { return read(f); } catch { return ''; } }).join('\n');
    for (const s of SECRETS) expect(all, s).not.toContain(s);

    const txns = read('transactions.jsonl').split('\n').map(l => JSON.parse(l));
    expect(txns).toHaveLength(5);
    const zelle = txns.find(t => t.amount === -150);
    expect(zelle.payee).toBe('Zelle payment to [email]');
    expect(zelle.memo).toBe('thanks! call [phone]');
    expect(zelle.merchant).not.toContain('@');
    expect(zelle.account).toBe('Total Checking …6789');
    expect(txns.find(t => t.amount === -60).description).toBe('ACH DEBIT …6789 CITY UTILITY');
    expect(txns.find(t => t.amount === -25).payee).toBe('CARD …1111 QQ MARKET');
    // Ordinary text, amounts and dates are untouched.
    expect(txns.find(t => t.amount === -8.5)).toMatchObject({ payee: 'STARBUCKS #1234', date: '2026-05-16' });

    const accounts = JSON.parse(read('accounts.json'));
    expect(accounts.properties[0]).toMatchObject({ place: 'Springfield, OR', zestimate: 815000 });
    expect(accounts.properties[0]).not.toHaveProperty('address');
    expect(accounts.accounts[0].name).toBe('Total Checking …6789');
    expect(list).toContain('its street address is not included');
    expect(list).toContain('long reference numbers in the text are masked');
  });
});

describe('a change suggested for a masked merchant', () => {
  it('still finds the real merchant, and only when the masked name is unambiguous', async () => {
    // What the model saw for "ach debit 000123456789 city utility".
    const p = await previewAction({ type: 'recategorize_merchant', merchant: 'ach debit …6789 city utility', category: 'Water', scope: 'merchant' });
    expect(p.title).toContain('Move 1 transaction');
    expect(p.after).toBe('Water');
    await expect(previewAction({ type: 'recategorize_merchant', merchant: 'ach debit …0000 city utility', category: 'Water', scope: 'merchant' }))
      .rejects.toThrow(/no transactions from a merchant/);
  });
});

describe('privacy rules in the chat prompt', () => {
  const text = privacyInstructions();
  it('limits how the data is used', () => {
    expect(text).toMatch(/Use only what the question needs/);
    expect(text).toMatch(/private individuals/);
    expect(text).toMatch(/Never ask for a Social Security number, a full account or card number, a password/);
    expect(text).toMatch(/Do not try to reconstruct them/);
  });
  it('keeps the assistant honest about where data goes', () => {
    expect(text).toMatch(/sent to Anthropic through the user's own Claude account/);
    expect(text).toMatch(/Do not say that nothing leaves their computer/);
    expect(text).toMatch(/You do not know how long Anthropic keeps them/);
  });
  it('is part of every chat prompt', () => {
    expect(systemPrompt('ctx')).toContain('# Privacy');
  });
});
