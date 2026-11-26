// Keep the last finished result of an expensive computation and serve it
// straight away, recomputing behind the scenes when it has aged.
//
// The Investments endpoints used to rebuild their whole answer on every
// request, and the inputs they wait on (fund holdings, prices) lived only in
// process memory, so each restart made the next page load slow again. A stored
// result survives restarts: it lives in provider_cache next to a fingerprint
// of everything in the database it was computed from.
//
// What is served, given the stored copy and the fingerprint right now:
//
//  - `edits` differ (or there is no copy): the user changed something that
//    changes the answer (a classification, a cost basis, a property, a hidden
//    account, ...). The stored copy is NOT served; the caller waits for a
//    recompute. An edit therefore shows on the very next fetch.
//  - `edits` match but the copy is stale (the bank feed synced since, it is
//    older than `freshMs`, it is from another UTC day, or from before this
//    process started): the copy is served at once, marked `refreshing`, and a
//    recompute runs in the background. The client asks again shortly.
//  - otherwise the copy is served as it is.
//
// Recomputes are single-flight per key: concurrent loads share one. A waiting
// caller joins a running recompute only when it started from the same
// fingerprint, so it can never be handed an answer from before its own edit.
//
// A result built while a provider lookup was failing (lookupHealth.ts) is
// `degraded`: it is kept only briefly, and never replaces a good copy of the
// same inputs.
import { readProviderCache, writeProviderCache, listProviderCache, deleteProviderCachePrefix } from '../db/providerCache.js';
import { lookupFailureCount } from './lookupHealth.js';

// `edits`: inputs the user sets; a change must show on the next fetch.
// `feed`: inputs a sync replaces; a change may show a moment later.
export interface Fingerprint { edits: string; feed: string }

export interface StoredSpec<T> {
  key: string;                       // provider_cache key, under RESULT_PREFIX
  compute: () => Promise<T>;
  fingerprint: () => Fingerprint;
  freshMs?: number;
}

// `computedAt` is when the served value was computed (ms since the epoch);
// `refreshing` says a newer one is on its way.
export interface Served<T> { value: T; computedAt: number; refreshing: boolean }

export const RESULT_PREFIX = 'result:';
const DEFAULT_FRESH_MS = 6 * 3600 * 1000;
// A degraded result is retried soon, and a failed background recompute is not
// retried on every page load in between.
const DEGRADED_FRESH_MS = 2 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 2 * 60 * 1000;
// A recompute still running after this long is taken for hung (a provider
// request that never returns) and no longer counts: the next load starts
// another, rather than the stored copy saying "refreshing" for good.
const FLIGHT_TIMEOUT_MS = 5 * 60 * 1000;

interface Payload<T> { edits: string; feed: string; degraded: boolean; value: T }
interface Loaded<T> extends Payload<T> { computedAt: number }
interface Flight<T> { edits: string; feed: string; began: number; run: Promise<Loaded<T>> }

const memory = new Map<string, Loaded<unknown>>();
const flights = new Map<string, Flight<unknown>>();
const retryAfter = new Map<string, number>();
// A copy computed by an earlier process is served, then refreshed: this
// process may be a newer build, and its lookups start from a cold memory.
const startedAt = Date.now();

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function load<T>(key: string): Loaded<T> | null {
  const mem = memory.get(key);
  if (mem) return mem as Loaded<T>;
  let row: ReturnType<typeof readProviderCache<Payload<T>>> = null;
  try { row = readProviderCache<Payload<T>>(key); } catch { /* unreadable: treat as absent */ }
  const p = row?.payload;
  if (!row || !p || typeof p.edits !== 'string' || typeof p.feed !== 'string' || !('value' in p)) return null;
  const loaded: Loaded<T> = { edits: p.edits, feed: p.feed, degraded: !!p.degraded, value: p.value, computedAt: row.fetchedAt };
  memory.set(key, loaded);
  return loaded;
}

function save<T>(key: string, loaded: Loaded<T>): void {
  memory.set(key, loaded);
  const { computedAt, ...payload } = loaded;
  try { writeProviderCache<Payload<T>>(key, { fetchedAt: computedAt, payload }); } catch { /* memory still has it */ }
}

function isStale(entry: Loaded<unknown>, fp: Fingerprint, freshMs: number, now: number): boolean {
  return entry.feed !== fp.feed
    || entry.computedAt < startedAt
    || now - entry.computedAt > (entry.degraded ? DEGRADED_FRESH_MS : freshMs)
    || utcDay(entry.computedAt) !== utcDay(now);
}

// Start a recompute for `spec` from fingerprint `fp` and make it the key's
// current flight.
function start<T>(spec: StoredSpec<T>, fp: Fingerprint): Flight<T> {
  const flight: Flight<T> = { edits: fp.edits, feed: fp.feed, began: Date.now(), run: undefined as unknown as Promise<Loaded<T>> };
  flight.run = (async () => {
    const failuresBefore = lookupFailureCount();
    const value = await spec.compute();
    const degraded = lookupFailureCount() !== failuresBefore;
    const fresh: Loaded<T> = { edits: fp.edits, feed: fp.feed, degraded, value, computedAt: Date.now() };
    // A run that hit a failing provider must not replace a good copy of the
    // very same inputs: keep the good one, and try again a little later.
    const prev = load<T>(spec.key);
    if (degraded && prev && !prev.degraded && prev.edits === fp.edits && prev.feed === fp.feed) {
      retryAfter.set(spec.key, Date.now() + RETRY_AFTER_FAILURE_MS);
      return prev;
    }
    // Superseded by a later flight (the inputs moved on while this ran): that
    // one stores its answer; this one is only handed to whoever awaited it.
    if (flights.get(spec.key) === flight) save(spec.key, fresh);
    return fresh;
  })().finally(() => { if (flights.get(spec.key) === flight) flights.delete(spec.key); });
  flights.set(spec.key, flight as Flight<unknown>);
  return flight;
}

// The key's running recompute, unless it has been running implausibly long.
function running<T>(key: string): Flight<T> | undefined {
  const flight = flights.get(key) as Flight<T> | undefined;
  return flight && Date.now() - flight.began < FLIGHT_TIMEOUT_MS ? flight : undefined;
}

// A recompute nobody is waiting on: a failure is logged and backed off, and
// the stored copy keeps being served.
function inBackground<T>(spec: StoredSpec<T>, fp: Fingerprint): void {
  start(spec, fp).run.catch(err => {
    retryAfter.set(spec.key, Date.now() + RETRY_AFTER_FAILURE_MS);
    console.error(`[stored] background recompute of ${spec.key} failed:`, err);
  });
}

export async function serveStored<T>(spec: StoredSpec<T>): Promise<Served<T>> {
  const fp = spec.fingerprint();
  const entry = load<T>(spec.key);
  const flight = running<T>(spec.key);

  if (entry && entry.edits === fp.edits) {
    const now = Date.now();
    if (!isStale(entry, fp, spec.freshMs ?? DEFAULT_FRESH_MS, now)) {
      return { value: entry.value, computedAt: entry.computedAt, refreshing: false };
    }
    let refreshing = !!flight;
    if (!flight && now >= (retryAfter.get(spec.key) ?? 0)) { inBackground(spec, fp); refreshing = true; }
    return { value: entry.value, computedAt: entry.computedAt, refreshing };
  }

  // Nothing stored for these inputs: wait for a recompute, sharing a running
  // one only if it started from this same fingerprint.
  const run = flight && flight.edits === fp.edits && flight.feed === fp.feed ? flight : start(spec, fp);
  const loaded = await run.run;
  return { value: loaded.value, computedAt: loaded.computedAt, refreshing: false };
}

// Bring a stored result up to date without anyone waiting on it (after a sync,
// at startup). Does nothing when the stored copy is current or a recompute for
// these inputs is already running.
export function refreshStored<T>(spec: StoredSpec<T>): void {
  const fp = spec.fingerprint();
  const flight = running<T>(spec.key);
  if (flight && flight.edits === fp.edits && flight.feed === fp.feed) return;
  const entry = load<T>(spec.key);
  if (entry && entry.edits === fp.edits && !isStale(entry, fp, spec.freshMs ?? DEFAULT_FRESH_MS, Date.now())) return;
  inBackground(spec, fp);
}

/** Keys of every stored result (with RESULT_PREFIX), for the startup and post-sync refresh. */
export function storedResultKeys(): string[] {
  try { return listProviderCache(RESULT_PREFIX).map(r => r.key); } catch { return []; }
}

// Forget every stored result, in memory and in the database. For a restore or
// an erase: the results belong to the data that was just replaced.
export function clearStoredResults(): void {
  memory.clear();
  flights.clear();
  retryAfter.clear();
  try { deleteProviderCachePrefix(RESULT_PREFIX); } catch { /* nothing stored */ }
}
