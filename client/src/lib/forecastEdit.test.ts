import { describe, it, expect } from 'vitest';
import {
  previewForecastChange, applyForecastChange, currentForecastValue, fmtForecastValue,
  type ForecastAction, type ForecastPlan,
} from './forecastEdit.ts';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EARNERS } from './forecastConfig.ts';
import { FORECAST_FIELDS } from '@shared/assistantAction';

const plan = (): ForecastPlan => ({
  assumptions: { ...DEFAULT_ASSUMPTIONS, annualSpending: 84000 },
  earners: DEFAULT_EARNERS.map(e => ({ ...e })),
});
const act = (field: string, value: number | boolean): ForecastAction => ({ type: 'set_forecast_assumption', field, value });
const preview = (a: ForecastAction, p = plan()) => {
  const r = previewForecastChange(a, p);
  if (!r.ok) throw new Error(r.error);
  return r.preview;
};

describe('fmtForecastValue', () => {
  it('formats each kind of input the way the Forecast page shows it', () => {
    expect(fmtForecastValue('investReturn', 0.07)).toBe('7%');
    expect(fmtForecastValue('inflation', 0.025)).toBe('2.5%');
    expect(fmtForecastValue('gradCoverage', 0.5)).toBe('50%');
    expect(fmtForecastValue('annualSpending', 84000)).toBe('$84,000');
    expect(fmtForecastValue('earner0.retireAge', 62)).toBe('62');
    expect(fmtForecastValue('collegeYears', 4)).toBe('4 years');
    expect(fmtForecastValue('collegeYears', 1)).toBe('1 year');
    expect(fmtForecastValue('earner1.enabled', true)).toBe('On');
    expect(fmtForecastValue('earner0.ssEnabled', false)).toBe('Off');
  });
});

describe('currentForecastValue', () => {
  it('reads assumptions and both earners for every whitelisted input', () => {
    const p = plan();
    for (const field of Object.keys(FORECAST_FIELDS)) {
      const v = currentForecastValue(p, field);
      expect(typeof v).toBe(FORECAST_FIELDS[field].kind === 'boolean' ? 'boolean' : 'number');
    }
    expect(currentForecastValue(p, 'annualSpending')).toBe(84000);
    expect(currentForecastValue(p, 'earner0.retireAge')).toBe(65);
    expect(currentForecastValue(p, 'earner1.income')).toBe(120000);
    expect(currentForecastValue(p, 'earner1.enabled')).toBe(false);
  });

  it('falls back to the default for an assumption an old saved plan lacks, and 0 for an unset match', () => {
    const p = plan();
    delete (p.assumptions as Partial<typeof p.assumptions>).eduInflation;
    delete p.earners[0].employerMatch;
    expect(currentForecastValue(p, 'eduInflation')).toBe(DEFAULT_ASSUMPTIONS.eduInflation);
    expect(currentForecastValue(p, 'earner0.employerMatch')).toBe(0);
  });
});

describe('previewForecastChange', () => {
  it('shows the current and the proposed value in plain words', () => {
    expect(preview(act('investReturn', 0.05))).toMatchObject({
      title: 'Change the forecast: investment return', before: '7%', after: '5%', noop: false,
    });
    expect(preview(act('earner0.retireAge', 62))).toMatchObject({
      title: 'Change the forecast: your retirement age', before: '65', after: '62',
    });
    expect(preview(act('annualSpending', 90000))).toMatchObject({ before: '$84,000', after: '$90,000' });
  });

  it('is a no-op when the plan already has that value', () => {
    expect(preview(act('earner0.retireAge', 65)).noop).toBe(true);
    expect(preview(act('earner1.enabled', false)).noop).toBe(true);
  });

  it('notes when a partner input has no effect because the partner is off', () => {
    expect(preview(act('earner1.retireAge', 60)).detail).toMatch(/partner is not included/);
    expect(preview(act('earner1.enabled', true)).detail).not.toMatch(/partner is not included/);
    const p = plan(); p.earners[1].enabled = true;
    expect(preview(act('earner1.retireAge', 60), p).detail).not.toMatch(/partner is not included/);
  });

  it('refuses a plan-to age at or before the current age, and the reverse', () => {
    expect(previewForecastChange(act('endAge', 50), { ...plan(), earners: [{ ...DEFAULT_EARNERS[0], currentAge: 55 }, DEFAULT_EARNERS[1]] }))
      .toEqual({ ok: false, error: 'The plan-to age has to be later than your current age (55).' });
    expect(previewForecastChange(act('earner0.currentAge', 95), plan()))
      .toEqual({ ok: false, error: 'Your current age has to be earlier than the plan-to age (90).' });
    expect(previewForecastChange(act('endAge', 95), plan()).ok).toBe(true);
  });

  it('refuses a field that is not on the whitelist', () => {
    expect(previewForecastChange(act('annualIncome', 1), plan()).ok).toBe(false);
  });
});

describe('applyForecastChange', () => {
  it('changes one assumption and nothing else, without mutating the plan', () => {
    const before = plan();
    const snapshot = JSON.stringify(before);
    const after = applyForecastChange(act('investReturn', 0.05), before);
    expect(after.assumptions).toEqual({ ...before.assumptions, investReturn: 0.05 });
    expect(after.earners).toBe(before.earners); // untouched, same reference
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('changes one earner field on the right earner', () => {
    const before = plan();
    const after = applyForecastChange(act('earner1.retireAge', 60), before);
    expect(after.assumptions).toBe(before.assumptions);
    expect(after.earners[1]).toEqual({ ...before.earners[1], retireAge: 60 });
    expect(after.earners[0]).toBe(before.earners[0]);
  });

  it('fills defaults for keys an old saved plan lacks, like the Forecast page does', () => {
    const old = { assumptions: { investReturn: 0.08 } as unknown as ForecastPlan['assumptions'], earners: plan().earners };
    const after = applyForecastChange(act('inflation', 0.025), old);
    expect(after.assumptions).toEqual({ ...DEFAULT_ASSUMPTIONS, investReturn: 0.08, inflation: 0.025 });
  });

  it('can switch the partner on and Social Security off', () => {
    let p = applyForecastChange(act('earner1.enabled', true), plan());
    p = applyForecastChange(act('earner0.ssEnabled', false), p);
    expect(p.earners[1].enabled).toBe(true);
    expect(p.earners[0].ssEnabled).toBe(false);
  });
});
