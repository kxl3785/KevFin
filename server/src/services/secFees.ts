// Fund expense ratios from SEC EDGAR — the fallback for the fee check-up when
// Yahoo has no figure for a fund (or its lookup failed). Since 2024 every
// open-end fund's annual and semi-annual Tailored Shareholder Report (forms
// N-CSR / N-CSRS) is filed as inline XBRL, and each share class's expense
// ratio is tagged `oef:ExpenseRatioPct`: a decimal fraction (0.0014 = 0.14%)
// whose context carries the class as an `oef:ClassAxis` member named after the
// EDGAR class id (`…:C000007773Member`).
//
// Pipeline (4 requests per fund, then cached in SQLite):
//   1. ticker → series + class id via sec.gov/files/company_tickers_mf.json
//      (edgarHoldings' mfTickerMapping: downloaded weekly, shared, in memory)
//   2. series → newest N-CSR/N-CSRS via browse-edgar (atom feed). `type=N-CSR`
//      is a prefix filter there, so the feed also lists N-CSRS and amendments;
//      each entry's own form type decides.
//   3. filing → index.json, to find the extracted XBRL instance (`*_htm.xml`,
//      typically 1–2 MB)
//   4. instance → the ExpenseRatioPct fact for this class, latest period
//
// The semi-annual (N-CSRS) figure is taken as-is: Form N-1A Item 27A has the
// shareholder report state the expense ratio ANNUALIZED for a period shorter
// than a year, so it is comparable to the annual one. That is the rule as
// written; it has not been checked against a filing's rendered text here.
//
// Privacy: only the fund's ticker — and the public series/class ids and filing
// numbers derived from it — goes out, as the choice of which public file to
// read, with the user's own declared SEC contact identity. Every request goes
// through edgarHoldings' fetchText/fetchJson (one identity, one throttle, one
// 403/429 tracker); with no contact email set nothing is sent at all.
//
// Caching: each ticker's answer is kept in provider_cache (`sec_fee:TICKER`)
// for 30 days; "SEC has no figure" (not a registered fund, no shareholder
// report, no tagged ratio for the class) for 14 days; a failed lookup (network,
// 403/429, mapping unavailable) isn't kept at all, so the next call retries —
// meanwhile an expired figure is still served (stale-on-error).

import { readProviderCache, writeProviderCache } from '../db/providerCache.js';
import { edgarUserAgent, EdgarError, fetchJson, fetchText, mfTickerMapping } from './edgarHoldings.js';
import { isValidExpenseRatio } from '../util/expenseRatio.js';

export interface SecExpenseRatio {
  ratio: number;  // fraction of the balance per year (0.0014 = 0.14%)
  asOf: string;   // end of the reporting period the figure covers, YYYY-MM-DD
  form: string;   // the filing it came from: 'N-CSR' (annual) or 'N-CSRS' (semi-annual)
}

export const CACHE_PREFIX = 'sec_fee:';
export const RATIO_TTL_MS = 30 * 24 * 3600 * 1000;   // reports come twice a year
export const MISSING_TTL_MS = 14 * 24 * 3600 * 1000; // a new report can appear any week
// Refuse absurd instances. A TSR instance covers every class in the filing, so
// a big trust's runs to a few MB; anything past this is not worth the download.
export const MAX_INSTANCE_BYTES = 15 * 1024 * 1024;
// How many recent shareholder reports / instance files to try before giving up:
// a filing can cover only some of a trust's series, and a fund that changed
// trusts may have an older report under the same series.
const MAX_FILINGS = 2;
const MAX_INSTANCES = 3;

interface CachedFee { fee: SecExpenseRatio | null }

// --- Pure parsers (exported for tests) ---

export interface ShareholderReport { form: string; filed: string; cik: string | null; accession: string }

const REPORT_FORMS = new Set(['N-CSR', 'N-CSRS']);

// The shareholder reports in a browse-edgar atom feed, newest filing first.
// Amendments (N-CSR/A) are skipped: they usually refile a certification or an
// exhibit, not the report. Entries with no parseable accession are dropped.
export function parseShareholderReports(atom: string): ShareholderReport[] {
  const out: ShareholderReport[] = [];
  for (const m of atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const form = (e.match(/<filing-type>\s*([^<]+?)\s*<\/filing-type>/)?.[1]
      ?? e.match(/<category[^>]*\bterm="([^"]+)"/)?.[1] ?? '').toUpperCase();
    if (!REPORT_FORMS.has(form)) continue;
    const filed = e.match(/<filing-date>\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    const href = e.match(/Archives\/edgar\/data\/(\d+)\/(\d{18})\//);
    const acc = e.match(/(\d{10})-(\d{2})-(\d{6})/);
    const accession = href?.[2] ?? (acc ? `${acc[1]}${acc[2]}${acc[3]}` : '');
    if (!accession) continue;
    out.push({ form, filed, cik: href?.[1] ?? null, accession });
  }
  // Stable sort: same-day filings keep the feed's (newest-first) order.
  return out.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
}

// The XBRL instance files in a filing's index.json, largest first. Inline-XBRL
// filings carry the extracted instance as `<document>_htm.xml`.
export function instanceFiles(index: unknown): { name: string; size: number | null }[] {
  const items = (index as { directory?: { item?: { name?: unknown; size?: unknown }[] } })?.directory?.item ?? [];
  return items
    .filter(i => typeof i?.name === 'string' && /_htm\.xml$/i.test(i.name))
    .map(i => {
      const size = Number(i.size);
      return { name: i.name as string, size: i.size !== '' && Number.isFinite(size) ? size : null };
    })
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
}

// A context: its period end (endDate for a duration, else instant) and its
// dimensions as [axis local name, member local name] pairs.
interface Ctx { end: string; dims: { axis: string; member: string }[] }

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1).trim();

function parseContexts(xml: string): Map<string, Ctx> {
  const out = new Map<string, Ctx>();
  // Contexts appear as <xbrli:context> or, with xbrli as the default
  // namespace (as in the SEC's extracted instances), plain <context>.
  for (const m of xml.matchAll(/<((?:[\w.-]+:)?context)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const body = m[3];
    const end = body.match(/<(?:[\w.-]+:)?(?:endDate|instant)>\s*([0-9-]{10})/)?.[1];
    if (!end) continue;
    const dims: Ctx['dims'] = [];
    for (const d of body.matchAll(/<(?:[\w.-]+:)?(explicitMember|typedMember)\b[^>]*\bdimension="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1>/g)) {
      dims.push({ axis: localName(d[2]), member: d[1] === 'explicitMember' ? localName(d[3]) : '' });
    }
    out.set(m[2], { end, dims });
  }
  return out;
}

/**
 * The expense ratio a shareholder-report instance gives for one share class
 * (`classId`, e.g. "C000007773"), or null when it has none. Only facts whose
 * context has the ClassAxis as its ONLY dimension count — a fact split further
 * (by another axis) isn't the class's headline figure. Values outside 0..5%
 * are rejected as mis-tagged. When the instance holds several periods for the
 * class, the latest period end wins.
 */
export function parseExpenseRatioFacts(xml: string, classId: string): { ratio: number; asOf: string } | null {
  const want = classId.trim().toUpperCase();
  if (!/^C\d+$/.test(want)) return null;
  const contexts = parseContexts(xml);
  let best: { ratio: number; asOf: string } | null = null;
  // Whatever prefix the filer bound to the OEF namespace; nil facts
  // (self-closing) never match.
  for (const m of xml.matchAll(/<((?:[\w.-]+:)?)ExpenseRatioPct\b([^>]*)>([^<]*)<\/\1ExpenseRatioPct>/g)) {
    const ref = m[2].match(/\bcontextRef="([^"]+)"/)?.[1];
    const ctx = ref ? contexts.get(ref) : undefined;
    if (!ctx || ctx.dims.length !== 1 || ctx.dims[0].axis !== 'ClassAxis') continue;
    const member = ctx.dims[0].member.match(/(C\d+)Member$/i)?.[1]?.toUpperCase();
    if (member !== want) continue;
    const text = m[3].trim();
    const ratio = /^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(text) ? Number(text) : NaN;
    if (!isValidExpenseRatio(ratio)) continue;
    if (!best || ctx.end > best.asOf) best = { ratio, asOf: ctx.end };
  }
  return best;
}

// --- Orchestration ---

// One SEC round-trip. null = SEC definitively has no figure (cacheable);
// throws on anything transient so nothing false gets cached.
async function lookup(sym: string): Promise<SecExpenseRatio | null> {
  const map = await mfTickerMapping.get();
  if (map.size === 0) throw new Error(`EDGAR fund-ticker mapping unavailable${mfTickerMapping.failureSuffix()}`);
  const fund = map.get(sym);
  // Not a registered fund (a stock, a 529 portfolio, a CIT), or a row with no
  // class id: expense ratios are tagged per class, so there's nothing to match.
  if (!fund?.classId) return null;

  const atom = await fetchText(
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.seriesId}&type=N-CSR&dateb=&owner=include&count=10&output=atom`,
  );
  const reports = parseShareholderReports(atom).slice(0, MAX_FILINGS);

  let tried = 0;
  for (const report of reports) {
    const base = `https://www.sec.gov/Archives/edgar/data/${report.cik ?? fund.cik}/${report.accession}`;
    const files = instanceFiles(await fetchJson(`${base}/index.json`));
    for (const file of files) {
      if (tried >= MAX_INSTANCES) return null;
      if (file.size != null && file.size > MAX_INSTANCE_BYTES) continue;
      tried++;
      const xml = await fetchText(`${base}/${file.name}`);
      if (xml.length > MAX_INSTANCE_BYTES) continue; // index lacked a size
      const hit = parseExpenseRatioFacts(xml, fund.classId);
      if (hit) return { ...hit, form: report.form };
    }
  }
  // No report since 2024's iXBRL rule, or none tags this class (ETFs that
  // file N-CSR still tag it; money-market funds don't file TSRs at all).
  return null;
}

const inflight = new Map<string, Promise<SecExpenseRatio | null>>();

async function resolve(sym: string, now: number): Promise<SecExpenseRatio | null> {
  const cacheKey = CACHE_PREFIX + sym;

  // An expired but valid figure, kept to fall back on if the refresh fails.
  let stale: SecExpenseRatio | null = null;
  try {
    const hit = readProviderCache<CachedFee>(cacheKey);
    if (hit) {
      const fee = hit.payload?.fee ?? null;
      const valid = fee && isValidExpenseRatio(fee.ratio) ? fee : null;
      const ttl = fee ? RATIO_TTL_MS : MISSING_TTL_MS;
      if (now - hit.fetchedAt < ttl) return valid;
      stale = valid;
    }
  } catch { /* unreadable cache row: fall through to a fresh lookup */ }

  // No identity: never contact SEC; whatever was cached is still served.
  if (!edgarUserAgent()) return stale;

  let fee: SecExpenseRatio | null;
  try {
    fee = await lookup(sym);
  } catch (err) {
    if (!(err instanceof EdgarError && err.kind === 'no-contact')) console.error(`SEC expense-ratio lookup failed for ${sym}:`, err);
    return stale; // not cached: the next call retries
  }
  try { writeProviderCache<CachedFee>(cacheKey, { fetchedAt: now, payload: { fee } }); } catch { /* best-effort */ }
  return fee;
}

/**
 * A fund's expense ratio from its latest SEC shareholder report (N-CSR or
 * N-CSRS), or null when SEC has none, no SEC contact email is set, or the
 * lookup failed (failure is not cached). Never throws. Concurrent calls for
 * the same symbol share one lookup.
 */
export async function fetchSecExpenseRatio(symbol: string, now = Date.now()): Promise<SecExpenseRatio | null> {
  const key = (symbol ?? '').trim().toUpperCase();
  if (!key) return null;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p: Promise<SecExpenseRatio | null> = resolve(key, now)
    .catch(() => null)
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

// Test hook: forget in-flight lookups.
export function resetSecFeeState(): void {
  inflight.clear();
}
