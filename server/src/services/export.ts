import { getNetWorthHistory, getCurrentBreakdown } from './netWorth.js';
import { getAllocation } from './allocation.js';
import { getPerformance } from './performance.js';
import { getBudget } from './budget.js';
import { renderSnapshotHtml } from './snapshotTemplate.js';

// A point-in-time export of everything the dashboard shows, encrypted with a
// user-supplied password and embedded in a single self-contained HTML file.
// The file works offline with no server: the recipient types the password and
// the viewer decrypts and renders it entirely in their browser. See
// snapshotTemplate.ts for the matching decrypt/render side.

export interface SnapshotMeta {
  generatedAt: string;       // ISO timestamp of the export
  appName: string;
  // Soft expiry: enforced only by the viewer (it refuses to render past this
  // date). NOT cryptographically enforceable — anyone with the file + password
  // can bypass it. Lives inside the encrypted payload so it can't be edited
  // without the password. null = never expires.
  expiresAt: string | null;
}

// PBKDF2 work factor. Must match the viewer (snapshotTemplate.ts). 600k is the
// current OWASP guidance for PBKDF2-HMAC-SHA256.
const PBKDF2_ITERATIONS = 600_000;

const enc = new TextEncoder();

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString('base64');
}

export interface EncryptedPayload {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;  // base64
  iv: string;    // base64
  ct: string;    // base64, AES-GCM ciphertext + auth tag
}

// Derive an AES-256-GCM key from the password and encrypt the JSON. Uses the
// Web Crypto API (global `crypto` in Node 20+) so the algorithm and parameters
// are identical to the browser viewer — no third-party crypto on either side.
export async function encryptPayload(obj: unknown, password: string): Promise<EncryptedPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const plaintext = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

// Assemble the full snapshot. The optional sections (allocation/performance/
// budget) depend on price fetches and imported transactions and may be empty;
// we degrade to null rather than failing the whole export.
export async function gatherSnapshot() {
  // Cap the embedded net-worth history to the last 12 months. The full series
  // spans ~5 years of daily points and the file has to carry every one of them;
  // a year keeps the shared chart meaningful while shrinking the payload.
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const history = (getNetWorthHistory(10000) as { date: string }[]) // newest-first
    .filter(p => p.date >= cutoffISO);

  const breakdown = getCurrentBreakdown();

  const [allocationFull, performance, budget] = await Promise.all([
    getAllocation().catch(err => { console.error('[export] allocation failed:', err); return null; }),
    getPerformance(365).catch(err => { console.error('[export] performance failed:', err); return null; }),
    getBudget().catch(err => { console.error('[export] budget failed:', err); return null; }),
  ]);

  // The viewer only renders the asset-class breakdown, so embed just that (plus
  // the total). The full allocation carries per-holding sector/country/stock
  // look-throughs — by far the largest part of the payload — that nothing in the
  // snapshot displays.
  const allocation = allocationFull
    ? { total: allocationFull.total, byAssetClass: allocationFull.byAssetClass }
    : null;

  return {
    netWorth: { history, breakdown },
    allocation,
    performance,
    budget,
  };
}

// Top-level entry point: gather → encrypt → render the standalone HTML file.
export async function exportSnapshotHtml(password: string, expiresAt: string | null): Promise<string> {
  const data = await gatherSnapshot();
  const meta: SnapshotMeta = {
    generatedAt: new Date().toISOString(),
    appName: 'KevFin',
    expiresAt,
  };
  const payload = await encryptPayload({ meta, data }, password);
  return renderSnapshotHtml(payload, { generatedAt: meta.generatedAt, expiresAt });
}
