// Ticker symbols for fund holdings that SEC N-PORT filings identify only by
// CUSIP / ISIN, looked up through OpenFIGI's free mapping API
// (https://api.openfigi.com/v3/mapping). Matching N-PORT issuer names to
// tickers misses a lot (renames, share classes, "INC/THE"…); an identifier
// lookup doesn't.
//
// Privacy: the only thing ever sent is public security identifiers copied out
// of public fund filings (e.g. Apple's CUSIP 037833100) — never a balance,
// account, position size or anything else about the user. An optional
// OPENFIGI_API_KEY is sent as a header, read per request and never logged.
//
// Eligible: a 9-char CUSIP (preferred, idType ID_CUSIP) or a US ISIN (ID_ISIN).
// Foreign ISINs are skipped on purpose — their primary listings carry local
// tickers ("7203" for Toyota) that are no use to the US price/metadata feeds.
//
// Cache: provider_cache under `figi:CUSIP:<id>` / `figi:ISIN:<id>` (whichever
// was queried), payload { ticker }. A ticker is kept 90 days, a conclusive "no
// usable ticker" 30 days; a failed request (429, 5xx, network) isn't kept, so
// the id is asked again later.
//
// Page loads never wait on this: knownTicker() only reads the cache, and
// queueTickerLookups() just queues misses for one background worker that drains
// the queue under OpenFIGI's limits and stops when it's empty:
//   no key:   10 jobs/request, 25 requests/min allowed → we stay ≤ 20/min
//   with key: 100 jobs/request, 25 requests/6s allowed → we stay ≤ 20/6s
// A 429 puts the batch back and waits out `ratelimit-reset` (else 60s); any
// other failure waits 30s and re-queues the batch, giving up after 3 tries.
import { readProviderCache, writeProviderCache } from '../db/providerCache.js';

export interface SecurityIdent { isin?: string; cusip?: string }

const DAY_MS = 24 * 3600 * 1000;
export const HIT_TTL_MS = 90 * DAY_MS;
export const MISS_TTL_MS = 30 * DAY_MS;
export const CACHE_PREFIX = 'figi:';

const API_URL = 'https://api.openfigi.com/v3/mapping';
const MAX_QUEUE = 5000;          // extras are dropped; the caller re-queues them on a later load
const MAX_ATTEMPTS = 3;          // per id, for non-429 failures
const FAILURE_BACKOFF_MS = 30_000;
const DEFAULT_THROTTLE_MS = 60_000;
const MAX_THROTTLE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface Limits { jobsPerRequest: number; requestsPerWindow: number; windowMs: number }
const ANON_LIMITS: Limits = { jobsPerRequest: 10, requestsPerWindow: 20, windowMs: 60_000 };
const KEYED_LIMITS: Limits = { jobsPerRequest: 100, requestsPerWindow: 20, windowMs: 6_000 };
const LONGEST_WINDOW_MS = 60_000;

type IdType = 'ID_CUSIP' | 'ID_ISIN';
interface Lookup { idType: IdType; idValue: string; cacheKey: string }
interface QueuedLookup extends Lookup { attempts: number }
interface Cached { ticker: string | null }

// ── Eligibility ───────────────────────────────────────────────────────────────

const CUSIP_RE = /^[0-9A-Z*@#]{8}[0-9]$/;
const US_ISIN_RE = /^US[0-9A-Z]{9}[0-9]$/;

// N-PORT uses all-zero CUSIPs as a "none" placeholder.
function cleanCusip(v: string | undefined): string | null {
  const c = (v ?? '').trim().toUpperCase();
  return CUSIP_RE.test(c) && !/^0+$/.test(c) ? c : null;
}

function cleanUsIsin(v: string | undefined): string | null {
  const i = (v ?? '').trim().toUpperCase();
  return US_ISIN_RE.test(i) && !/^US0+$/.test(i) ? i : null;
}

// The eligible lookups for one security, preferred first (CUSIP, then US ISIN).
function lookupsFor(id: SecurityIdent): Lookup[] {
  const out: Lookup[] = [];
  const cusip = cleanCusip(id?.cusip);
  if (cusip) out.push({ idType: 'ID_CUSIP', idValue: cusip, cacheKey: `${CACHE_PREFIX}CUSIP:${cusip}` });
  const isin = cleanUsIsin(id?.isin);
  if (isin) out.push({ idType: 'ID_ISIN', idValue: isin, cacheKey: `${CACHE_PREFIX}ISIN:${isin}` });
  return out;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

function readCached(cacheKey: string, now: number): string | null | undefined {
  try {
    const hit = readProviderCache<Cached>(cacheKey);
    if (!hit) return undefined;
    const t = hit.payload?.ticker;
    const ticker = typeof t === 'string' && t ? t : null;
    return now - hit.fetchedAt < (ticker ? HIT_TTL_MS : MISS_TTL_MS) ? ticker : undefined;
  } catch {
    return undefined; // unreadable row: treat as never looked up
  }
}

// Sync, cache only. A ticker from either identifier wins over a "none" from the other.
export function knownTicker(id: SecurityIdent): string | null | undefined {
  const now = Date.now();
  let sawNone = false;
  for (const l of lookupsFor(id)) {
    const t = readCached(l.cacheKey, now);
    if (typeof t === 'string') return t;
    if (t === null) sawNone = true;
  }
  return sawNone ? null : undefined;
}

// ── Picking a ticker from one mapping job ─────────────────────────────────────

export interface FigiRecord {
  ticker?: string | null; exchCode?: string | null; marketSector?: string | null;
  securityType?: string | null; securityType2?: string | null;
}

// Listed things a US price feed can quote, vs. the side securities (warrants,
// rights, preferreds) that share an issuer's CUSIP family.
const GOOD_TYPE_RE = /common stock|\badr\b|\bgdr\b|depositary|\breit\b|\betp\b|closed-end|open-end|mutual fund|ny reg|\bmlp\b|ltd part|tracking stk|royalty|stapled/i;
const SIDE_TYPE_RE = /warrant|\bright|prefer|\bpfd\b/i;
const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;

// Yahoo spells share classes with a dash ("BRK/B" → "BRK-B").
function yahooTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase().replace(/\//g, '-');
  return TICKER_RE.test(t) ? t : null;
}

// The US composite listing's ticker, or null when OpenFIGI has no US listing.
export function pickTicker(data: FigiRecord[]): string | null {
  const us = (Array.isArray(data) ? data : [])
    .filter(d => d && d.exchCode === 'US')
    .map(d => ({ d, ticker: yahooTicker(d.ticker) }))
    .filter((x): x is { d: FigiRecord; ticker: string } => x.ticker !== null);
  const types = (d: FigiRecord) => `${d.securityType ?? ''} ${d.securityType2 ?? ''}`;
  const equity = us.filter(x => x.d.marketSector === 'Equity');
  const best =
    equity.find(x => GOOD_TYPE_RE.test(types(x.d)) && !SIDE_TYPE_RE.test(types(x.d))) ??
    equity.find(x => !SIDE_TYPE_RE.test(types(x.d))) ??
    equity[0] ??
    us[0];
  return best ? best.ticker : null;
}

// ── Worker ────────────────────────────────────────────────────────────────────

let queue: QueuedLookup[] = [];
const pendingKeys = new Set<string>(); // queued or in flight
let worker: Promise<void> | null = null;
let generation = 0;                     // bumped by resetFigiState(): stale workers bail
let sentAt: number[] = [];              // request send times, for the rate window
let lastError: string | null = null;
let resolvedCount = 0;
let wake: (() => void) | null = null;   // ends the current sleep early (reset)

function apiKey(): string | undefined {
  return process.env.OPENFIGI_API_KEY?.trim() || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => { wake = null; resolve(); }, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

async function waitForSlot(limits: Limits, gen: number): Promise<void> {
  while (gen === generation) {
    const now = Date.now();
    sentAt = sentAt.filter(t => now - t < LONGEST_WINDOW_MS);
    const recent = sentAt.filter(t => now - t < limits.windowMs);
    if (recent.length < limits.requestsPerWindow) return;
    await sleep(recent[0] + limits.windowMs - now + 1);
  }
}

type Outcome =
  | { kind: 'ok'; tickers: (string | null)[] }
  | { kind: 'throttled'; waitMs: number }
  | { kind: 'failed'; error: string };

// `ratelimit-reset` is seconds until the window resets.
function throttleWaitMs(header: string | null): number {
  const s = Number(header);
  if (!header || !Number.isFinite(s) || s <= 0) return DEFAULT_THROTTLE_MS;
  return Math.min(MAX_THROTTLE_MS, s * 1000 + 1000);
}

// One POST. Never throws.
async function sendBatch(batch: Lookup[], key: string | undefined): Promise<Outcome> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['X-OPENFIGI-APIKEY'] = key;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch.map(l => ({ idType: l.idType, idValue: l.idValue }))),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) return { kind: 'throttled', waitMs: throttleWaitMs(res.headers.get('ratelimit-reset')) };
    if (!res.ok) {
      const hint = res.status === 401 ? ' (check OPENFIGI_API_KEY)' : '';
      return { kind: 'failed', error: `OpenFIGI HTTP ${res.status}${hint}` };
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body) || body.length !== batch.length) {
      return { kind: 'failed', error: 'OpenFIGI returned an unexpected response' };
    }
    // Each job is { data: [...] }, or { error } / { warning } ("No identifier
    // found.") — both of which are a conclusive "no ticker".
    return {
      kind: 'ok',
      tickers: body.map(job => {
        const data = (job as { data?: unknown } | null)?.data;
        return Array.isArray(data) ? pickTicker(data as FigiRecord[]) : null;
      }),
    };
  } catch (err) {
    return { kind: 'failed', error: `OpenFIGI request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function runWorker(gen: number): Promise<void> {
  while (gen === generation && queue.length) {
    const key = apiKey();
    const limits = key ? KEYED_LIMITS : ANON_LIMITS;
    await waitForSlot(limits, gen);
    if (gen !== generation) return;

    const batch = queue.splice(0, limits.jobsPerRequest);
    sentAt.push(Date.now());
    const outcome = await sendBatch(batch, key);
    if (gen !== generation) return;

    if (outcome.kind === 'ok') {
      const now = Date.now();
      batch.forEach((l, i) => {
        try { writeProviderCache<Cached>(l.cacheKey, { fetchedAt: now, payload: { ticker: outcome.tickers[i] } }); } catch { /* best-effort */ }
        pendingKeys.delete(l.cacheKey);
      });
      resolvedCount += batch.length;
      lastError = null;
    } else if (outcome.kind === 'throttled') {
      lastError = 'OpenFIGI rate limit hit (429); waiting';
      queue.unshift(...batch);
      await sleep(outcome.waitMs);
    } else {
      lastError = outcome.error;
      for (const l of batch) {
        l.attempts++;
        if (l.attempts < MAX_ATTEMPTS) queue.push(l);
        else pendingKeys.delete(l.cacheKey); // give up for now; a later load re-queues it
      }
      if (queue.length) await sleep(FAILURE_BACKOFF_MS);
    }
  }
}

function startWorker(): void {
  if (worker || !queue.length) return;
  const gen = generation;
  worker = (async () => {
    await Promise.resolve(); // let the caller finish queueing so ids batch together
    try {
      await runWorker(gen);
    } catch (err) {
      // Not expected (sendBatch never throws); drop this round rather than spin.
      if (gen === generation) {
        lastError = `OpenFIGI worker stopped: ${err instanceof Error ? err.message : String(err)}`;
        queue = [];
        pendingKeys.clear();
      }
    }
  })().finally(() => {
    if (gen !== generation) return;
    worker = null;
    if (queue.length) startWorker(); // ids queued while the loop was exiting
  });
}

// Fire-and-forget. Never throws; never waits on the network.
export function queueTickerLookups(ids: SecurityIdent[]): void {
  try {
    const now = Date.now();
    for (const id of ids ?? []) {
      if (queue.length >= MAX_QUEUE) break;
      const lookups = lookupsFor(id);
      if (!lookups.length) continue;
      if (lookups.some(l => pendingKeys.has(l.cacheKey))) continue;
      if (lookups.some(l => readCached(l.cacheKey, now) !== undefined)) continue;
      const l = lookups[0];
      queue.push({ ...l, attempts: 0 });
      pendingKeys.add(l.cacheKey);
    }
    startWorker();
  } catch {
    /* diagnostics only; the next load re-queues */
  }
}

export function figiStatus(): { pending: number; resolved: number; lastError: string | null; keyed: boolean } {
  return { pending: pendingKeys.size, resolved: resolvedCount, lastError, keyed: !!apiKey() };
}

// ── Test hooks ────────────────────────────────────────────────────────────────

export function resetFigiState(): void {
  generation++;
  wake?.();
  wake = null;
  queue = [];
  pendingKeys.clear();
  worker = null;
  sentAt = [];
  lastError = null;
  resolvedCount = 0;
}

export async function drainFigiQueueForTest(): Promise<void> {
  while (worker) await worker;
}
