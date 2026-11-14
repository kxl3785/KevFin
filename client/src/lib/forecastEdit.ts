import { FORECAST_FIELDS, type AssistantAction } from '@shared/assistantAction';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS, padEarners, type Assumptions, type Earner } from './forecastConfig.ts';
import { writePersistent } from '../hooks/usePersistentState.ts';
import { fmtMoney } from './format.ts';

// Changing a Forecast input from the AI assistant.
//
// The Forecast (the retirement Monte Carlo) and its inputs are browser state,
// persisted under `mon.fcAssumptions` / `mon.fcEarners` — there is no server
// table to update. So when the user clicks Apply on a forecast change the
// assistant proposed, the change is made here, through the same persisted state
// the Forecast page's own inputs write (writePersistent: localStorage, the
// server-synced prefs, and every mounted hook, so an open Forecast page
// re-simulates at once).
//
// The action has already passed the shared whitelist and range check
// (shared/assistantAction.ts). This module adds what needs the current plan:
// the before/after wording for the card, the checks that involve two inputs,
// and the edit itself. The plan-in / plan-out functions are pure; only
// readForecastPlan / saveForecastChange touch storage.

export type ForecastAction = Extract<AssistantAction, { type: 'set_forecast_assumption' }>;
export interface ForecastPlan { assumptions: Assumptions; earners: Earner[] }
export interface ForecastPreview { title: string; before: string; after: string; detail?: string; noop: boolean }

const ASSUMPTIONS_KEY = 'mon.fcAssumptions';
const EARNERS_KEY = 'mon.fcEarners';
const EARNERS_EDITED_KEY = 'mon.fcEarnersEdited';
// When the assistant last changed an input. The projection summary the chat
// sends is only recomputed while the Forecast page is open, so the chat uses
// this to tell the assistant when that summary predates a change.
export const FORECAST_CHANGED_KEY = 'kevfin.assistant.fcChangedAt';

/** "earner1.retireAge" → { earner: 1, key: 'retireAge' }; a plain assumption → { key }. */
function splitField(field: string): { earner: 0 | 1 | null; key: string } {
  const m = /^earner([01])\.(\w+)$/.exec(field);
  return m ? { earner: Number(m[1]) as 0 | 1, key: m[2] } : { earner: null, key: field };
}

/** The value an input has in `plan` right now (falling back to the built-in default). */
export function currentForecastValue(plan: ForecastPlan, field: string): number | boolean {
  const { earner, key } = splitField(field);
  const kind = FORECAST_FIELDS[field].kind;
  const raw = earner === null
    ? (plan.assumptions as unknown as Record<string, unknown>)[key] ?? (DEFAULT_ASSUMPTIONS as unknown as Record<string, unknown>)[key]
    : (plan.earners[earner] as unknown as Record<string, unknown>)[key];
  if (kind === 'boolean') return raw === true;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0; // e.g. employerMatch never set
}

/** A plan value as the Forecast page would show it: "7%", "$70,000", "65", "On". */
export function fmtForecastValue(field: string, value: number | boolean): string {
  const kind = FORECAST_FIELDS[field].kind;
  if (kind === 'boolean') return value ? 'On' : 'Off';
  const n = value as number;
  if (kind === 'rate' || kind === 'fraction') return `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  if (kind === 'money') return fmtMoney(n);
  if (kind === 'years') return `${n} ${n === 1 ? 'year' : 'years'}`;
  return String(n);
}

/** What applying `action` to `plan` would do, or why it cannot be applied. */
export function previewForecastChange(action: ForecastAction, plan: ForecastPlan):
  { ok: true; preview: ForecastPreview } | { ok: false; error: string } {
  const spec = FORECAST_FIELDS[action.field];
  if (!spec) return { ok: false, error: 'That is not a forecast input.' };
  const before = currentForecastValue(plan, action.field);

  // The two inputs that bound the simulated span must stay in order.
  const myAge = plan.earners[0]?.currentAge ?? DEFAULT_EARNERS[0].currentAge;
  const endAge = plan.assumptions.endAge ?? DEFAULT_ASSUMPTIONS.endAge;
  if (action.field === 'endAge' && (action.value as number) <= myAge) {
    return { ok: false, error: `The plan-to age has to be later than your current age (${myAge}).` };
  }
  if (action.field === 'earner0.currentAge' && (action.value as number) >= endAge) {
    return { ok: false, error: `Your current age has to be earlier than the plan-to age (${endAge}).` };
  }

  const { earner } = splitField(action.field);
  const partnerOff = earner === 1 && action.field !== 'earner1.enabled' && !plan.earners[1]?.enabled;
  return {
    ok: true,
    preview: {
      title: `Change the forecast: ${spec.label.charAt(0).toLowerCase()}${spec.label.slice(1)}`,
      before: fmtForecastValue(action.field, before),
      after: fmtForecastValue(action.field, action.value),
      detail: partnerOff
        ? 'The partner is not included in the plan right now, so this has no effect until they are.'
        : 'Saved to your Forecast plan. The projection is re-run when the Forecast tab is open.',
      noop: before === action.value,
    },
  };
}

/** `plan` with the one input changed. Returns new objects; `plan` is not mutated. */
export function applyForecastChange(action: ForecastAction, plan: ForecastPlan): ForecastPlan {
  const { earner, key } = splitField(action.field);
  if (earner === null) {
    // Same merge the Forecast page's own inputs use, so missing keys get defaults.
    return { ...plan, assumptions: { ...DEFAULT_ASSUMPTIONS, ...plan.assumptions, [key]: action.value } };
  }
  return { ...plan, earners: plan.earners.map((e, i) => (i === earner ? { ...e, [key]: action.value } : e)) };
}

// --- storage -------------------------------------------------------------------

function readJson(key: string): unknown {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** The saved plan, with defaults for whatever has never been saved. */
export function readForecastPlan(): ForecastPlan {
  const a = readJson(ASSUMPTIONS_KEY);
  const e = readJson(EARNERS_KEY);
  return {
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...(a && typeof a === 'object' && !Array.isArray(a) ? a as Partial<Assumptions> : {}) },
    earners: padEarners(Array.isArray(e) ? e as Earner[] : DEFAULT_EARNERS),
  };
}

/**
 * Apply one approved forecast change to the saved plan. Re-reads the plan and
 * re-runs the preview first, so what is written is checked against the plan as
 * it is now, not as it was when the card was drawn. Returns what was done.
 */
export function saveForecastChange(action: ForecastAction): { done: string; changed: boolean } {
  const plan = readForecastPlan();
  const check = previewForecastChange(action, plan);
  if (!check.ok) throw new Error(check.error);
  if (check.preview.noop) return { done: 'Already in place — nothing needed changing.', changed: false };

  const next = applyForecastChange(action, plan);
  if (next.assumptions !== plan.assumptions) writePersistent(ASSUMPTIONS_KEY, next.assumptions);
  if (next.earners !== plan.earners) {
    writePersistent(EARNERS_KEY, next.earners);
    // Like an edit on the page: the earner figures are no longer the placeholders.
    writePersistent(EARNERS_EDITED_KEY, true);
  }
  try { localStorage.setItem(FORECAST_CHANGED_KEY, new Date().toISOString()); } catch { /* only a hint for the chat */ }
  const label = FORECAST_FIELDS[action.field].label;
  return { done: `${label}: ${check.preview.before} → ${check.preview.after}.`, changed: true };
}
