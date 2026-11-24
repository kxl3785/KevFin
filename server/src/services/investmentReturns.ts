import { getDb } from '../db/schema.js';
import { getAllPrefs } from './prefs.js';
import { benchmarkWindowReturn } from './performance.js';
import {
  timeWeightedReturn, moneyWeightedReturn, suspiciousJumps, daysBetween, dropBalanceGlitches,
  type Valuation, type Flow,
} from '../util/returns.js';
import {
  detectFlows, incomeSummary, parseFlowOverrides,
  type InvestmentTxn, type FlowOverrides, type DetectedFlow,
} from '../util/investmentFlows.js';
import type { ReturnsData, ReturnsAccount, ReturnsFlow, ReturnsTotal } from '../shared/apiTypes.js';

// Contribution-aware investment returns and dividend/interest income.
//
// The existing Performance chart reprices TODAY's holdings backwards, so it
// can't see deposits at all. This instead measures what each investment
// account actually did, from two kinds of recorded history:
//
//  - VALUES: the account's REAL daily balances (balance_observations rows with
//    estimated = 0, written by every sync and daily snapshot). Backfilled
//    "estimated" rows are never used — for brokerage they are themselves
//    today's holdings repriced, which would quietly bring the deposit blindness
//    back.
//  - FLOWS: deposits and withdrawals read from the account's own transactions
//    (util/investmentFlows.ts), with the user's include/exclude switches.
//
// An account is measured only where BOTH exist: from the later of the window
// start and its first stored transaction (before that, a deposit could be
// missing and would show up as gain), to its latest real balance. Anything
// without usable history is left out of the figures — with a reason and a
// coverage share — rather than guessed at.

// Server-side copy of the client's include/exclude switches (prefs store, so
// no schema change). Value: JSON { [transactionId]: 'include' | 'exclude' }.
export const FLOW_OVERRIDES_PREF = 'mon.returnsFlowOverrides';

// An account whose newest real balance — or whose provider's own balance date —
// is older than this is treated as no longer reporting (a stale value can't be
// compared with today's market).
const STALE_DAYS = 7;
// A one-day loss this close to −100% isn't a market move: it's a balance that
// read 0 with nothing recorded taking the money out. Such an account is left
// out ("not enough data") rather than shown at −100%.
const TOTAL_LOSS = -0.99;
// A one-day move bigger than this, not undone the next day, is flagged as a
// probable unrecorded deposit/withdrawal.
const JUMP_THRESHOLD = 0.2;

export interface ReturnsAccountInput {
  id: string; name: string; institution: string; balance: number;
  // When the provider last reported a NEW balance ('YYYY-MM-DD…'; SimpleFIN's
  // balance-date). The daily snapshot re-records the cached balance as a real
  // observation even when the sync failed, so the observations alone can't
  // show that a connection has stopped updating. Null/absent = unknown (Plaid).
  balanceDate?: string | null;
}

export interface ReturnsInput {
  today: string;
  windowStart: string;
  investmentAccounts: ReturnsAccountInput[];    // brokerage, not hidden
  observations: Map<string, Valuation[]>;       // REAL balances per account id
  investmentTxns: InvestmentTxn[];              // every stored txn of those accounts
  incomeAccounts: ReturnsAccountInput[];        // accounts whose income is totalled
  incomeTxns: InvestmentTxn[];                  // every stored txn of those accounts
                                                // (accounts not in investmentAccounts use the bank income rule)
  overrides: FlowOverrides;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtDay = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const listNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export interface Measured {
  acct: ReturnsAccountInput;
  vals: Valuation[];
  flows: DetectedFlow[];       // detected in the measured span (incl. user-excluded)
  counted: Flow[];             // the included ones
}

/** Pure core: everything except the DB reads and the benchmark fetch. */
export function computeReturns(input: ReturnsInput): ReturnsData {
  const { today, windowStart, overrides } = input;
  const caveats: string[] = [];

  const txnsByAcct = new Map<string, InvestmentTxn[]>();
  for (const t of input.investmentTxns) {
    const list = txnsByAcct.get(t.accountId) ?? [];
    list.push(t);
    txnsByAcct.set(t.accountId, list);
  }

  const accounts: ReturnsAccount[] = [];
  const measured: Measured[] = [];
  const flowsOut: ReturnsFlow[] = [];
  const jumpNotes: string[] = [];
  const unexplainedNotes: string[] = [];
  const glitchNotes: string[] = [];

  for (const acct of input.investmentAccounts) {
    const row: ReturnsAccount = {
      id: acct.id, name: acct.name, institution: acct.institution, balance: acct.balance,
      included: false, reason: null, measuredFrom: null, measuredTo: null, days: 0,
      timeWeighted: { periodReturn: null, annualized: null },
      moneyWeighted: { periodReturn: null, annualized: null },
      deposits: 0, withdrawals: 0, gain: null,
    };
    accounts.push(row);

    const txns = txnsByAcct.get(acct.id) ?? [];
    if (txns.length === 0) {
      row.reason = 'Its connection doesn’t send transactions, so deposits can’t be told apart from growth.';
      continue;
    }
    const balanceDay = acct.balanceDate && /^\d{4}-\d{2}-\d{2}/.test(acct.balanceDate) ? acct.balanceDate.slice(0, 10) : null;
    if (balanceDay && daysBetween(balanceDay, today) > STALE_DAYS) {
      row.reason = `Its connection hasn’t sent a new balance since ${fmtDay(balanceDay)}, so there isn’t enough data to measure it.`;
      continue;
    }
    const txnStart = txns.reduce((m, t) => (t.date < m ? t.date : m), txns[0].date);
    const obs = (input.observations.get(acct.id) ?? [])
      .filter(o => o.date <= today && Number.isFinite(o.value))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Starting balance: the latest real balance on or before the later of the
    // window start and the first transaction — but never one from before the
    // transactions begin (a deposit in that gap would be invisible). Failing
    // that, the first real balance after it.
    const s0 = windowStart > txnStart ? windowStart : txnStart;
    let startIdx = -1;
    for (let i = obs.length - 1; i >= 0; i--) {
      if (obs[i].date <= s0) { if (obs[i].date >= txnStart) startIdx = i; break; }
    }
    if (startIdx < 0) startIdx = obs.findIndex(o => o.date >= s0);
    const vals = startIdx >= 0 ? obs.slice(startIdx) : [];

    if (vals.length < 2 || daysBetween(vals[0].date, vals[vals.length - 1].date) < 1) {
      row.reason = vals.length === 0 && obs.length === 0
        ? 'No daily balances recorded yet. KevFin starts keeping one a day once an account is connected.'
        : 'Not enough daily balances recorded yet in this period to measure it.';
      continue;
    }
    const last = vals[vals.length - 1];
    if (daysBetween(last.date, today) > STALE_DAYS) {
      row.reason = `No balance recorded since ${fmtDay(last.date)}.`;
      continue;
    }

    // Flows inside (first balance day, last balance day] — the same window the
    // return math uses, so the list shows exactly what was counted.
    const flows = detectFlows(txns, overrides).filter(f => f.date > vals[0].date && f.date <= last.date);
    const counted: Flow[] = flows.filter(f => f.included).map(f => ({ date: f.date, amount: f.amount }));
    // Failed-sync zero balances out, so the combined total skips them too.
    const clean = dropBalanceGlitches(vals, counted);
    const twr = timeWeightedReturn(clean.vals, counted);
    const mwr = moneyWeightedReturn(clean.vals, counted);

    const wipe = twr.daily.find(d => d.ret <= TOTAL_LOSS);
    if (wipe) {
      row.reason = `Its balance fell to zero on ${fmtDay(wipe.date)} with no recorded withdrawal, so there isn’t enough data to measure it.`;
      continue;
    }

    const deposits = counted.filter(f => f.amount > 0).reduce((s, f) => s + f.amount, 0);
    const withdrawals = counted.filter(f => f.amount < 0).reduce((s, f) => s - f.amount, 0);

    Object.assign(row, {
      included: true,
      measuredFrom: vals[0].date,
      measuredTo: last.date,
      days: daysBetween(vals[0].date, last.date),
      timeWeighted: { periodReturn: twr.periodReturn, annualized: twr.annualized, days: twr.days },
      moneyWeighted: { periodReturn: mwr.periodReturn, annualized: mwr.annualized, days: mwr.days },
      deposits: round2(deposits),
      withdrawals: round2(withdrawals),
      gain: round2(last.value - vals[0].value - (deposits - withdrawals)),
    });
    measured.push({ acct, vals: clean.vals, flows, counted });
    for (const f of flows) flowsOut.push({ ...f, accountName: acct.name });

    for (const j of suspiciousJumps(twr.daily, JUMP_THRESHOLD).slice(0, 3)) {
      jumpNotes.push(`${acct.name} moved ${j.ret > 0 ? '+' : ''}${pct(j.ret)} on ${fmtDay(j.date)}`);
    }
    for (const d of twr.unexplained.slice(0, 3)) {
      unexplainedNotes.push(`${acct.name} on ${fmtDay(d)}`);
    }
    for (const d of clean.dropped.slice(0, 3)) {
      glitchNotes.push(`${acct.name} on ${fmtDay(d)}`);
    }
  }

  const total = combineTotal(measured);

  // ---- Coverage -------------------------------------------------------------
  const totalBalance = input.investmentAccounts.reduce((s, a) => s + a.balance, 0);
  const includedBalance = accounts.filter(a => a.included).reduce((s, a) => s + a.balance, 0);
  const share = totalBalance > 0 ? Math.min(1, Math.max(0, includedBalance / totalBalance)) : null;
  const includedCount = accounts.filter(a => a.included).length;

  // ---- Caveats (plain language, most important first) -----------------------
  const left = accounts.filter(a => !a.included);
  if (input.investmentAccounts.length === 0) {
    caveats.push('No investment accounts are connected yet.');
  } else if (left.length > 0) {
    caveats.push(
      includedCount === 0
        ? 'None of your investment accounts have enough recorded history yet, so returns with deposits removed can’t be worked out. The reason for each is listed below.'
        : `${includedCount} of ${accounts.length} investment accounts ${includedCount === 1 ? 'is' : 'are'} included${share != null ? `, holding ${Math.round(share * 100)}% of the balance` : ''}. The others are left out rather than guessed at: ${listNames(left.map(a => a.name))}.`,
    );
  }
  const late = accounts.filter(a => a.included && a.measuredFrom && daysBetween(windowStart, a.measuredFrom) > STALE_DAYS);
  if (late.length > 0) {
    caveats.push(`Some accounts are measured from a later date because their recorded history starts then: ${listNames(late.map(a => `${a.name} (from ${fmtDay(a.measuredFrom!)})`))}.`);
  }
  const guessed = flowsOut.filter(f => f.basis === 'guessed' && f.included);
  if (guessed.length > 0) {
    caveats.push(`${guessed.length} money movement${guessed.length === 1 ? '' : 's'} didn’t match a familiar description and ${guessed.length === 1 ? 'is' : 'are'} counted as a deposit or withdrawal to be safe. Check the list and switch off any that were really earnings.`);
  }
  if (jumpNotes.length > 0) {
    caveats.push(`Large one-day changes with no recorded deposit or withdrawal: ${listNames(jumpNotes)}. If money moved in or out then, the figures are off by that amount.`);
  }
  if (glitchNotes.length > 0) {
    caveats.push(`A balance of zero between two normal ones looked like a failed sync and was skipped (${listNames(glitchNotes)}).`);
  }
  if (unexplainedNotes.length > 0) {
    caveats.push(`Value appeared with nothing recorded going in (${listNames(unexplainedNotes)}); those days are left out of the return.`);
  }
  if (total && total.timeWeighted.periodReturn != null && total.moneyWeighted.periodReturn == null) {
    caveats.push('The return on your dollars couldn’t be worked out for this period (the money going in and out has no single consistent rate).');
  }

  // ---- Income ---------------------------------------------------------------
  // Accounts that aren't investment accounts (savings, checking) count income
  // under the stricter bank rule: only interest / credit-union dividends.
  const investIds = new Set(input.investmentAccounts.map(a => a.id));
  const bankAccountIds = new Set(input.incomeAccounts.filter(a => !investIds.has(a.id)).map(a => a.id));
  const income = incomeSummary(input.incomeTxns, today, { bankAccountIds });
  const nameOf = new Map(input.incomeAccounts.map(a => [a.id, a.name]));
  const incomeTxnAccts = new Set(input.incomeTxns.map(t => t.accountId));
  const noTxnInvest = input.investmentAccounts.filter(a => !incomeTxnAccts.has(a.id));
  if (noTxnInvest.length > 0) {
    caveats.push(`Dividends and interest from ${listNames(noTxnInvest.map(a => a.name))} aren’t counted, because ${noTxnInvest.length === 1 ? 'its connection doesn’t' : 'their connections don’t'} send transactions.`);
  }

  return {
    windowStart,
    windowEnd: today,
    total,
    coverage: {
      includedBalance: round2(includedBalance),
      totalBalance: round2(totalBalance),
      share,
      includedCount,
      accountCount: accounts.length,
    },
    accounts,
    flows: flowsOut.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
    benchmark: null,
    income: {
      ...income,
      byAccount: income.byAccount.map(a => ({ ...a, name: nameOf.get(a.accountId) ?? 'Other account' })),
    },
    caveats,
  };
}

/**
 * The combined figure across every included account. Values are summed on the
 * union of their balance dates, each account carried at its latest balance
 * (and counted as 0 before its own measured start). An account that starts
 * later than the others enters the total as a deposit of its starting value on
 * its start day (valued at that day's close), so its arrival is never mistaken
 * for growth.
 */
export function combineTotal(measured: Measured[]): ReturnsTotal | null {
  if (measured.length === 0) return null;
  const starts = measured.map(m => m.vals[0].date);
  const globalStart = starts.reduce((a, b) => (b < a ? b : a));
  const dates = [...new Set(measured.flatMap(m => m.vals.map(v => v.date)))].sort();

  const totalVals: Valuation[] = dates.map(date => {
    let sum = 0;
    for (const m of measured) {
      if (date < m.vals[0].date) continue;
      // latest balance on or before `date` (vals are sorted; spans are small)
      let v = m.vals[0].value;
      for (const x of m.vals) { if (x.date <= date) v = x.value; else break; }
      sum += v;
    }
    return { date, value: sum };
  });

  // Counted flows are netted per day across accounts: a move from one measured
  // account to another on the same day (taxable → Roth, an ACATS between two
  // connected brokerages) cancels out, because for the portfolio as a whole no
  // money came or went. Legs that post on different days stay separate — the
  // dip and the matching rise link back to the right answer on their own.
  // Each account's own figures keep both legs.
  const netByDay = new Map<string, number>();
  for (const m of measured) {
    for (const f of m.counted) netByDay.set(f.date, (netByDay.get(f.date) ?? 0) + f.amount);
  }
  const netFlows: Flow[] = [...netByDay]
    .filter(([, amount]) => Math.abs(amount) >= 0.005)
    .map(([date, amount]) => ({ date, amount }));
  const flows: Flow[] = [...netFlows];
  for (const m of measured) {
    // Joins at its first close: valued at that day's close, so it earns nothing
    // in the combined figure that day ('end' timing).
    if (m.vals[0].date > globalStart) flows.push({ date: m.vals[0].date, amount: m.vals[0].value, timing: 'end' });
  }
  const twr = timeWeightedReturn(totalVals, flows);
  const mwr = moneyWeightedReturn(totalVals, flows);

  const deposits = netFlows.filter(f => f.amount > 0).reduce((a, f) => a + f.amount, 0);
  const withdrawals = netFlows.filter(f => f.amount < 0).reduce((a, f) => a - f.amount, 0);
  const startValue = measured.reduce((s, m) => s + m.vals[0].value, 0);
  const endValue = measured.reduce((s, m) => s + m.vals[m.vals.length - 1].value, 0);
  const measuredTo = dates[dates.length - 1];
  return {
    measuredFrom: globalStart,
    measuredTo,
    days: daysBetween(globalStart, measuredTo),
    timeWeighted: { periodReturn: twr.periodReturn, annualized: twr.annualized, days: twr.days },
    moneyWeighted: { periodReturn: mwr.periodReturn, annualized: mwr.annualized, days: mwr.days },
    startValue: round2(startValue),
    endValue: round2(endValue),
    deposits: round2(deposits),
    withdrawals: round2(withdrawals),
    gain: round2(endValue - startValue - (deposits - withdrawals)),
  };
}

const toDate = (posted: number) => new Date(posted * 1000).toISOString().slice(0, 10);

/** DB-backed entry point for GET /api/performance/returns. */
export async function getReturns(days: number, benchmarkId = 'SPY'): Promise<ReturnsData> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const ws = new Date();
  ws.setUTCDate(ws.getUTCDate() - days);
  const windowStart = ws.toISOString().slice(0, 10);

  const rows = db.prepare(
    `SELECT id, name, custom_name, org_name, balance, category, source, balance_date, updated_at FROM accounts
     WHERE hidden = 0 AND category IN ('brokerage', 'banking')`,
  ).all() as {
    id: string; name: string; custom_name: string | null; org_name: string; balance: number; category: string;
    source: string | null; balance_date: string | null; updated_at: string | null;
  }[];
  // When the provider last sent a new balance: SimpleFIN's own balance-date;
  // for Plaid (which has none) the row's updated_at, which only a successful
  // sync's upsert touches. Unknown otherwise — never treated as stale.
  const asInput = (r: typeof rows[number]): ReturnsAccountInput => ({
    id: r.id, name: r.custom_name ?? r.name, institution: r.org_name, balance: r.balance,
    balanceDate: r.balance_date ?? (r.source === 'plaid' ? r.updated_at : null),
  });
  const investmentAccounts = rows.filter(r => r.category === 'brokerage').map(asInput);
  // Income also counts interest paid by bank accounts (savings, checking).
  const incomeAccounts = rows.map(asInput);

  const obsStmt = db.prepare(
    'SELECT date, balance FROM balance_observations WHERE account_id = ? AND estimated = 0 ORDER BY date',
  );
  const observations = new Map<string, Valuation[]>();
  for (const a of investmentAccounts) {
    observations.set(a.id, (obsStmt.all(a.id) as { date: string; balance: number }[]).map(o => ({ date: o.date, value: o.balance })));
  }

  const ids = incomeAccounts.map(a => a.id);
  const txRows = ids.length === 0 ? [] : db.prepare(
    `SELECT id, account_id, posted, amount, payee, description, memo FROM transactions
     WHERE account_id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as { id: string; account_id: string; posted: number; amount: number; payee: string; description: string; memo: string }[];
  const allTxns: InvestmentTxn[] = txRows.map(t => ({
    id: t.id, accountId: t.account_id, date: toDate(t.posted), amount: t.amount,
    payee: t.payee ?? '', description: t.description ?? '', memo: t.memo ?? '',
  }));
  const investIds = new Set(investmentAccounts.map(a => a.id));

  const data = computeReturns({
    today,
    windowStart,
    investmentAccounts,
    observations,
    investmentTxns: allTxns.filter(t => investIds.has(t.accountId)),
    incomeAccounts,
    incomeTxns: allTxns,
    overrides: parseFlowOverrides(getAllPrefs()[FLOW_OVERRIDES_PREF]),
  });

  // Benchmark over exactly the dates the total covers (or the whole window
  // when nothing could be measured), from the same cached price series the
  // Performance chart uses.
  const from = data.total?.measuredFrom ?? windowStart;
  const to = data.total?.measuredTo ?? today;
  data.benchmark = await benchmarkWindowReturn(benchmarkId, from, to);
  if (!data.benchmark || data.benchmark.periodReturn == null) {
    data.caveats.push('The market comparison couldn’t be loaded for these dates.');
  }
  return data;
}
