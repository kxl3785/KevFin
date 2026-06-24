import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  CountryCode,
} from 'plaid';
import { plaidConfigured, resetPlaidClient } from './plaid.js';

// The same server/.env that dotenv loads at startup, resolved relative to this
// file so it works under both tsx (src) and the compiled build (dist).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '../../.env');

export const PLAID_ENVS = ['sandbox', 'development', 'production'] as const;
export type PlaidEnv = typeof PLAID_ENVS[number];

// Show only enough to recognise a key — never the secret itself.
function maskHint(secret: string | undefined): string | null {
  if (!secret) return null;
  return secret.length <= 4 ? '••••' : '••••' + secret.slice(-4);
}

// Status for the UI: booleans + masked hints, never the raw secrets.
export function getKeyStatus() {
  return {
    plaid: {
      set: plaidConfigured(),
      env: process.env.PLAID_ENV ?? 'sandbox',
      clientIdHint: maskHint(process.env.PLAID_CLIENT_ID),
      secretSet: Boolean(process.env.PLAID_SECRET),
    },
    openwebninja: {
      set: Boolean(process.env.OPENWEBNINJA_KEY),
      hint: maskHint(process.env.OPENWEBNINJA_KEY),
    },
  };
}

// Update process.env immediately (so lazy reads pick the keys up at once) and
// persist to server/.env, upserting each line and leaving comments/others intact.
function setEnvVars(updates: Record<string, string>): void {
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;

  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const lines = text.length ? text.split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex(l => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
}

// Pull a readable message out of a Plaid (axios) error.
function plaidErrorMessage(e: unknown): string {
  const data = (e as { response?: { data?: { error_message?: string; error_code?: string } } })?.response?.data;
  return data?.error_message || data?.error_code || 'Plaid rejected those credentials.';
}

// --- Validation: confirm a key works before we persist it ------------------

async function validatePlaid(clientId: string, secret: string, env: PlaidEnv): Promise<string | null> {
  const client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
  }));
  try {
    // Lightweight authenticated call — fails with INVALID_API_KEYS on bad creds.
    await client.institutionsGet({ count: 1, offset: 0, country_codes: [CountryCode.Us] });
    return null;
  } catch (e) {
    return plaidErrorMessage(e);
  }
}

export class KeyError extends Error {}

// Validate then persist Plaid credentials. Unprovided fields fall back to the
// current env, so the user can change just the secret (or just the environment).
export async function savePlaidKeys(input: {
  clientId?: string; secret?: string; env?: string;
}): Promise<void> {
  const clientId = (input.clientId ?? process.env.PLAID_CLIENT_ID ?? '').trim();
  const secret = (input.secret ?? process.env.PLAID_SECRET ?? '').trim();
  const env = (input.env ?? process.env.PLAID_ENV ?? 'production').trim();

  if (!clientId || !secret) throw new KeyError('Both a Plaid Client ID and Secret are required.');
  if (!PLAID_ENVS.includes(env as PlaidEnv)) throw new KeyError(`Environment must be one of: ${PLAID_ENVS.join(', ')}.`);

  const err = await validatePlaid(clientId, secret, env as PlaidEnv);
  if (err) throw new KeyError(err);

  const updates: Record<string, string> = { PLAID_ENV: env };
  if (input.clientId !== undefined) updates.PLAID_CLIENT_ID = clientId;
  if (input.secret !== undefined) updates.PLAID_SECRET = secret;
  setEnvVars(updates);
  resetPlaidClient(); // next Plaid call rebuilds the client from the new creds
}

// Persist the OpenWeb Ninja key (used for Zillow property values). zillow.ts
// reads process.env at call time, so this applies without a restart. We don't
// burn an API call validating it here — a wrong key simply fails the next
// property refresh with a logged error.
export function saveOpenWebNinjaKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new KeyError('A key is required.');
  setEnvVars({ OPENWEBNINJA_KEY: trimmed });
}
