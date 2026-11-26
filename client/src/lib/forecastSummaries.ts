// The words on the Forecast page's folded input rows and under the What-if
// sliders. Each folded section states its current values in one line ("40 ·
// $71,772 a year · retires at 65"), so the column reads as a digest of the plan
// and a section only needs opening to change something. Pure, so the text can
// be tested; amounts go through the page's `money` formatter, which masks them
// in privacy mode.

type Money = (n: number) => string;

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// "a", "a and b", "a, b and c"
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
const pctTxt = (v: number) => `${Math.round(v * 1000) / 10}%`;

// You / Partner: age · pay · retirement age.
export function earnerSummary(e: { currentAge: number; income: number; retireAge: number }, money: Money): string {
  return `${e.currentAge} · ${money(e.income)} a year · retires at ${e.retireAge}`;
}

// Social Security for the earners in the plan: "$36,000 + $30,000 from 67" when
// they claim at the same age, else each with its own age.
export function ssSummary(list: { enabled: boolean; annual: number; claimAge: number }[], money: Money): string {
  const on = list.filter(x => x.enabled);
  if (!on.length) return 'Not included';
  if (on.length === 1) return `${money(on[0].annual)} a year from ${on[0].claimAge}`;
  if (on.every(x => x.claimAge === on[0].claimAge)) return `${on.map(x => money(x.annual)).join(' + ')} from ${on[0].claimAge}`;
  return on.map(x => `${money(x.annual)} from ${x.claimAge}`).join(' + ');
}

// Spending, split the way the forecast spends it in its first year: everyday
// living plus housing (mortgage until payoff, property tax, insurance, HOA).
export function spendingSummary(s: { living: number; housing: number }, money: Money, rule?: string): string {
  const base = s.housing > 0.5 ? `${money(s.living)} living + ${money(s.housing)} housing` : `${money(s.living)} a year`;
  return rule ? `${base} · ${rule}` : base;
}

// Savings: the invested total, which tax buckets hold it (names as written in a
// sentence: "taxable", "pre-tax", "Roth"), and what goes in yearly.
export function savingsSummary(s: { total: number; buckets: string[]; contribPerYear: number; connected: boolean }, money: Money): string {
  if (!s.connected) return 'No accounts connected';
  const where = s.buckets.length ? ` in ${joinAnd(s.buckets)}` : '';
  return `${money(s.total)}${where} · ${s.contribPerYear > 0 ? `+${money(s.contribPerYear)}` : '$0'} a year going in`;
}

export function homeSummary(h: { count: number; equity: number; sellable: boolean }, money: Money): string {
  return `${plural(h.count, 'property', 'properties')} · ${money(h.equity)} equity${h.sellable ? ' · can fund retirement' : ''}`;
}

export function familySummary(f: { kids: number; planned: number; college: boolean }): string {
  if (!f.kids && !f.planned) return 'No kids added';
  const parts = [f.kids ? plural(f.kids, 'kid') : '', f.planned ? `${f.planned} planned` : ''].filter(Boolean);
  return `${parts.join(' · ')} · college ${f.college ? 'on' : 'off'}`;
}

export function assumptionsSummary(a: { investReturn: number; inflation: number; brackets: boolean; effTaxRate: number; retireTaxRate: number }): string {
  const tax = a.brackets ? 'IRS brackets' : `tax ${Math.round(a.effTaxRate * 100)}% → ${Math.round(a.retireTaxRate * 100)}%`;
  return `${pctTxt(a.investReturn)} return · ${pctTxt(a.inflation)} inflation · ${tax}`;
}

// --- What-if -----------------------------------------------------------------------
// One phrase per slider that has been moved, in the order the sliders sit.
export function leverPhrases(l: {
  retire: { plan: number; now: number } | null;
  spend: { pct: number; amount: number } | null;    // pct: −10 = 10% less; amount: the new yearly figure
  extraSave: number;
  ret: { plan: number; now: number } | null;        // fractions (0.07)
}, money: Money): string[] {
  const out: string[] = [];
  if (l.retire && l.retire.now !== l.retire.plan) out.push(`retiring at ${l.retire.now} instead of ${l.retire.plan}`);
  if (l.spend && l.spend.pct !== 0) out.push(`spending ${Math.abs(l.spend.pct)}% ${l.spend.pct > 0 ? 'more' : 'less'} (${money(l.spend.amount)} a year)`);
  if (l.extraSave > 0) out.push(`saving ${money(l.extraSave)} more a year`);
  if (l.ret && Math.abs(l.ret.now - l.ret.plan) > 1e-9) out.push(`a ${pctTxt(l.ret.now)} return instead of ${pctTxt(l.ret.plan)}`);
  return out;
}

// The combined effect of the moved sliders on the headline numbers, e.g.
// "Retiring at 62 instead of 65: chance stays 100%, and you'd have $5.1M at 62
// instead of $6.37M at 65." Null when nothing is moved.
export function whatIfSentence(p: {
  changes: string[];
  chance: { plan: number; now: number };
  retire: { planAge: number; planValue: number; nowAge: number; nowValue: number };
  money: Money;
}): string | null {
  if (!p.changes.length) return null;
  const what = joinAnd(p.changes);
  const lead = what.charAt(0).toUpperCase() + what.slice(1);
  const { plan, now } = p.chance;
  const chance = now === plan ? `chance stays ${now}%` : `chance ${now > plan ? 'rises' : 'falls'} from ${plan}% to ${now}%`;
  const r = p.retire;
  const same = Math.abs(r.nowValue - r.planValue) <= Math.max(500, Math.abs(r.planValue) * 0.005);
  const money = p.money;
  const retire = r.nowAge === r.planAge
    ? (same ? `about the same ${money(r.nowValue)} at retirement` : `${money(r.nowValue)} at retirement instead of ${money(r.planValue)}`)
    : `${money(r.nowValue)} at ${r.nowAge} instead of ${money(r.planValue)} at ${r.planAge}`;
  return `${lead}: ${chance}, and you’d have ${retire}.`;
}
