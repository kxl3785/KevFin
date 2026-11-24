import { SPEND_STEP, type PlanAnswersResult } from './forecastSolve.ts';

// The words and figures on the "What your plan supports" card, built from one
// solver result (lib/forecastSolve.ts). Pure, so the card's text can be tested.
//
// Everything here is read from the RESULT — its targets, its investable balance,
// its spending rule, its lead earner — never from the page's live settings, so
// while a new solve is running the old answers keep the words they were worked
// out with. Dollar amounts go through the page's `money` formatter (which masks
// them in privacy mode). Estimates for planning, not advice.

export interface AnswerTile { key: 'spend' | 'retire' | 'independence' | 'coast'; label: string; value: string; sub: string; tip: string; bar?: number }
// A guardrail line. `text` is the whole sentence (screen readers, plain text);
// `act`, `when` and `detail` are the same words split for the card's compact
// callout: the spending change, the balance that triggers it, and the rest.
// Each is a list of plain strings and {strong} amounts to emphasise.
export type Words = (string | { strong: string })[];
export interface GuardLine { glyph: '▼' | '▲'; text: string; act: Words | null; when: Words; detail: string }

const pct = (v: number) => `${Math.round(v * 100)}%`;
const years = (n: number) => `${n} year${n === 1 ? '' : 's'}`;

export function answerTiles(r: PlanAnswersResult, ctx: {
  money: (n: number) => string;
  endAge: number;
  earnerLabel: (index: number) => string | undefined; // the earner's name on the page ("Partner" when blank)
}): AnswerTile[] {
  // Share of savings: none of the answers apply (see answersNote).
  if (r.rule === 'percentOfPortfolio') return [];
  const { money } = ctx;
  const t = r.targets;
  const inv = r.current.investable;
  const guard = r.rule === 'guardrails';
  const ruleTip = guard ? ' It counts on your guardrails spending rule to cut spending in bad years, so in some futures you would spend less.' : '';
  // Whose retirement the age and coast answers move: earner 0's, or the partner's
  // when earner 0 has already retired.
  const lead = r.lead;
  const partnerLead = !!lead && lead.index !== 0;
  const name = partnerLead ? (ctx.earnerLabel(lead!.index)?.trim() || 'Partner') : '';
  const whose = partnerLead ? `${name}’s` : 'your';
  const tiles: AnswerTile[] = [];

  const ss = r.safeSpending;
  tiles.push({
    key: 'spend',
    label: guard ? 'Safe starting spending' : 'Safe yearly spending',
    value: ss.status === 'ok' ? money(ss.amount) : ss.status === 'unbounded' ? 'No limit found' : 'None',
    sub: ss.status === 'ok' ? `you plan ${money(r.current.spending)}${guard ? ' · cut in bad years' : ''}`
      : ss.status === 'unbounded' ? 'the plan holds at any everyday spending tried'
      : `fixed costs alone fall short of ${pct(t.target)}`,
    tip: guard
      ? `The most everyday spending a year to start retirement with (your Annual spending figure, in $${SPEND_STEP} steps) at which at least ${pct(t.target)} of simulated futures never run out.${ruleTip} Housing, college, kids yet to come and life events stay as entered.`
      : `The most everyday spending a year (your Annual spending figure, in $${SPEND_STEP} steps) at which at least ${pct(t.target)} of simulated futures never run out. Housing, college, kids yet to come and life events stay as entered. The technical name is a safe withdrawal amount at a ${pct(t.target)} success rate.`,
  });

  const er = r.earliestRetirement;
  let retireValue: string, retireSub: string;
  if (er.status === 'ok' && lead) {
    const now = er.age <= lead.currentAge;
    retireValue = partnerLead ? `${name}: ${now ? 'now' : `age ${er.age}`}` : now ? 'Now' : `Age ${er.age}`;
    retireSub = (er.shift === 0 ? `${whose} planned age`
      : `${years(Math.abs(er.shift))} ${er.shift < 0 ? 'before' : 'after'} ${whose} planned ${lead.retireAge}`)
      + (!partnerLead && er.partnerAge != null ? ` · partner at ${er.partnerAge}` : '');
  } else if (er.status === 'never') {
    retireValue = 'Not in the plan'; retireSub = `even working to ${ctx.endAge}`;
  } else {
    retireValue = 'Already retired'; retireSub = 'nobody in the plan is still working';
  }
  tiles.push({
    key: 'retire',
    label: 'Earliest workable retirement',
    value: retireValue, sub: retireSub,
    tip: `The youngest retirement age at which at least ${pct(t.target)} of futures still last, with today’s spending. Everyone still working moves by the same number of years${partnerLead ? `; the age shown is ${name}’s, since you have already retired` : ''}.${ruleTip}`,
  });

  const ind = r.independence;
  tiles.push({
    key: 'independence',
    label: 'Enough to stop working now',
    value: ind.status === 'ok' ? (ind.amount === 0 ? 'Already there' : money(ind.amount)) : 'Out of reach',
    sub: ind.status === 'ok'
      ? (ind.amount === 0 ? 'income you’ll keep receiving covers the plan' : ind.progress >= 1 ? `reached · you have ${money(inv)}` : `you’re ${Math.floor(ind.progress * 100)}% of the way`)
      : 'no balance tried was enough',
    bar: ind.status === 'ok' && ind.amount > 0 ? Math.min(1, ind.progress) : undefined,
    tip: `The investable balance (taxable, pre-tax, Roth and HSA) at which everyone could stop working today and still have at least ${pct(t.target)} of futures last, at today’s spending. Often called a financial independence number.${ruleTip}`,
  });

  const c = r.coast;
  const retiring = lead ? (partnerLead ? `${name} retiring at ${lead.retireAge}` : `retiring at ${lead.retireAge}`) : '';
  tiles.push({
    key: 'coast',
    label: 'Enough to stop saving',
    value: c.status === 'ok' ? money(c.amount) : c.status === 'retired' ? '—' : 'Out of reach',
    sub: c.status === 'ok'
      ? (c.coasting ? `reached · ${retiring} needs no new saving` : `${money(Math.max(0, c.amount - inv))} more than today`)
      : c.status === 'retired' ? 'you’re already retired' : `no balance tried carries ${whose} retirement at ${lead?.retireAge ?? ''}`,
    tip: `The investable balance that, with no further saving (no contributions, no employer match, leftover pay spent), still carries retirement at the planned age for at least ${pct(t.target)} of futures. Planned sales and rent still count. Often called a coast number.${ruleTip}`,
  });
  return tiles;
}

// The card's own spending guardrails (steady spending only).
export function guardrailLines(r: PlanAnswersResult, money: (n: number) => string): GuardLine[] {
  const g = r.guardrails;
  if (!g || r.safeSpending.status !== 'ok') return [];
  const S = r.safeSpending.amount, t = r.targets, inv = r.current.investable;
  const b = (s: string) => ({ strong: s });
  const out: GuardLine[] = [];
  if (g.lower) {
    const when: Words = ['If investments fall below ', b(money(g.lower.balance))];
    if (g.lower.spending != null) {
      const detail = `Below that, ${money(S)} a year has less than a ${pct(t.lower)} chance; ${money(g.lower.spending)} brings it back to ${pct(t.target)}.`;
      out.push({ glyph: '▼', text: `Cut to ${money(g.lower.spending)} a year if investments fall below ${money(g.lower.balance)}. ${detail}`,
        act: ['Cut to ', b(money(g.lower.spending)), ' a year'], when, detail });
    } else {
      out.push({ glyph: '▼', text: `If investments fall below ${money(g.lower.balance)}, ${money(S)} a year has less than a ${pct(t.lower)} chance, and no spending level brings it back to ${pct(t.target)}.`,
        act: null, when, detail: `${money(S)} a year then has less than a ${pct(t.lower)} chance, and no spending level brings it back to ${pct(t.target)}.` });
    }
  } else {
    out.push({ glyph: '▼', text: `No lower guardrail: even with nothing invested, ${money(S)} a year keeps at least a ${pct(t.lower)} chance.`,
      act: null, when: ['No lower guardrail'], detail: `Even with nothing invested, ${money(S)} a year keeps at least a ${pct(t.lower)} chance.` });
  }
  if (g.upper) {
    const past = g.upper.balance <= inv;
    const when: Words = ['If investments pass ', b(money(g.upper.balance)), past ? ' (they already do)' : ''];
    if (g.upper.spending != null) {
      const detail = `Above that, ${money(S)} a year has more than a ${pct(t.upper)} chance; ${money(g.upper.spending)} keeps it at ${pct(t.target)}.`;
      out.push({ glyph: '▲', text: `Raise to ${money(g.upper.spending)} a year if investments pass ${money(g.upper.balance)}${past ? ' (they already do)' : ''}. ${detail}`,
        act: ['Raise to ', b(money(g.upper.spending)), ' a year'], when, detail });
    } else {
      out.push({ glyph: '▲', text: `If investments pass ${money(g.upper.balance)}, ${money(S)} a year has more than a ${pct(t.upper)} chance.`,
        act: null, when, detail: `${money(S)} a year then has more than a ${pct(t.upper)} chance.` });
    }
  } else {
    out.push({ glyph: '▲', text: `No upper guardrail found: no balance tried lifts the chance at ${money(S)} a year past ${pct(t.upper)}.`,
      act: null, when: ['No upper guardrail found'], detail: `No balance tried lifts the chance at ${money(S)} a year past ${pct(t.upper)}.` });
  }
  return out;
}

// Words as plain text (for tests and screen readers).
export const wordsText = (w: Words | null) => (w ?? []).map(x => (typeof x === 'string' ? x : x.strong)).join('');

// Why some (or all) answers aren't shown under the plan's spending rule; null
// with steady spending.
export function answersNote(r: PlanAnswersResult): string | null {
  if (r.rule === 'percentOfPortfolio') {
    return 'Your spending rule spends a share of whatever savings are left each year, so savings never run out on everyday spending. '
      + 'Safe spending, the balances needed to stop working or saving, and the earliest retirement age all measure the chance of running out, '
      + 'so they don’t apply and aren’t shown. Switch Spending in retirement to Steady or Guardrails to see them.';
  }
  if (r.rule === 'guardrails') {
    return 'These answers count on your guardrails spending rule cutting spending in bad years, so safe spending is a starting amount. '
      + 'Spending guardrails aren’t worked out here because your rule already sets its own.';
  }
  return null;
}

// Where the chance figures come from.
export function sourceNote(r: PlanAnswersResult): string {
  return r.historical
    ? 'Worked out from the past starting years that fit your plan, so the chance moves in steps of one starting year.'
    : `Worked out from ${r.runs.toLocaleString('en-US')} simulated futures (the chart uses fewer), so its chance for today’s plan — ${pct(r.current.successRate)} — can differ from the headline by a point or two.`;
}
