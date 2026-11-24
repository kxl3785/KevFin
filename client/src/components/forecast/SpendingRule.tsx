import { useEffect, useId, useMemo, useState } from 'react';
import type { SimPathStat } from '../../lib/forecastSim.ts';
import {
  describeRule, pctText, resolvePctInput, RULE_LABELS, RULE_LIMITS, type WithdrawalRule, type WithdrawalRuleKind,
} from '../../lib/withdrawalRules.ts';
import { summarizeCuts } from '../../lib/backtest.ts';
import { Tip } from './TaxPicture.tsx';

// The retirement spending-rule picker, shown in the Forecast's "You" group under
// Annual spending. Read-only planning: it changes how the simulation spends, never
// any real account. Estimates for planning, not advice.

const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '5px 0', minHeight: 36, fontSize: 13, color: 'var(--muted)' };
const KINDS: WithdrawalRuleKind[] = ['fixed', 'guardrails', 'percentOfPortfolio'];

// A percent field that commits on blur / Enter (so typing doesn't re-run the
// forecast on every keystroke), clamped to [lo, hi]. `optional` lets it be
// cleared to mean "none". See resolvePctInput for what leaving the field does.
function PctField({ id, label, value, lo, hi, optional = false, onCommit }: {
  id: string; label: string; value: number | null; lo: number; hi: number; optional?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? '' : pctText(value));
  useEffect(() => { setText(value == null ? '' : pctText(value)); }, [value]);
  const commit = () => {
    const r = resolvePctInput(text, value, lo, hi, optional);
    setText(r.text);
    if (r.commit) onCommit(r.value);
  };
  return (
    <div style={rowStyle}>
      <label htmlFor={id}>{label}</label>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input id={id} inputMode="decimal" value={text} placeholder={optional ? 'none' : undefined}
          onChange={e => setText(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{ width: 64, textAlign: 'right', fontSize: 13, padding: '4px 8px' }} />
        <span aria-hidden="true">%</span>
      </span>
    </div>
  );
}

export default function SpendingRule({ rule, onChange, paths, historical }: {
  rule: WithdrawalRule;
  onChange: (r: WithdrawalRule) => void;
  paths?: SimPathStat[];   // the shown forecast's per-run stats (present when a rule is on)
  historical: boolean;     // the forecast is replaying past markets
}) {
  const uid = useId();
  const g = rule.guardrails, p = rule.percent;
  const cuts = useMemo(() => (rule.kind !== 'fixed' && paths?.length ? summarizeCuts(paths) : null), [rule.kind, paths]);
  const whole = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 12 }}>
      <fieldset style={{ border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
        <legend style={{ fontSize: 13, color: 'var(--muted)', padding: 0, marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Spending in retirement
          <Tip label="About retirement spending rules" width={300} text="How your everyday spending reacts to the markets once everyone has retired. Only that everyday spending moves; mortgage and home costs, kids, college and life events stay as planned. “Guardrails” is a simplified Guyton–Klinger rule: spending is cut or raised when the share of savings you spend each year drifts past a band (it does not skip the inflation raise after a down year). “Share of savings” is a percent-of-portfolio rule. Estimates for planning, not advice." />
        </legend>
        <div role="radiogroup" aria-label="Spending in retirement" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {KINDS.map(k => {
            const on = rule.kind === k;
            return (
              <label key={k} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', minHeight: 32,
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-dim)' : 'transparent',
                color: on ? 'var(--text)' : 'var(--muted)', borderRadius: 999, padding: '0 12px', fontWeight: on ? 600 : 400,
              }}>
                <input type="radio" name={`${uid}-rule`} value={k} checked={on} onChange={() => onChange({ ...rule, kind: k })}
                  style={{ width: 'auto', margin: 0 }} />
                {RULE_LABELS[k]}
              </label>
            );
          })}
        </div>
      </fieldset>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0 4px', lineHeight: 1.5, maxWidth: '72ch' }} aria-live="polite">{describeRule(rule)}</p>

      {rule.kind === 'guardrails' && (
        <div>
          <PctField id={`${uid}-up`} label="Spend less when the share rises by" value={g.upper} lo={RULE_LIMITS.band[0]} hi={RULE_LIMITS.band[1]}
            onCommit={v => onChange({ ...rule, guardrails: { ...g, upper: v ?? g.upper } })} />
          <PctField id={`${uid}-cut`} label="Cut spending by" value={g.cut} lo={RULE_LIMITS.step[0]} hi={RULE_LIMITS.step[1]}
            onCommit={v => onChange({ ...rule, guardrails: { ...g, cut: v ?? g.cut } })} />
          <PctField id={`${uid}-low`} label="Spend more when the share falls by" value={g.lower} lo={RULE_LIMITS.band[0]} hi={RULE_LIMITS.band[1]}
            onCommit={v => onChange({ ...rule, guardrails: { ...g, lower: v ?? g.lower } })} />
          <PctField id={`${uid}-raise`} label="Raise spending by" value={g.raise} lo={RULE_LIMITS.step[0]} hi={RULE_LIMITS.step[1]}
            onCommit={v => onChange({ ...rule, guardrails: { ...g, raise: v ?? g.raise } })} />
        </div>
      )}
      {rule.kind === 'percentOfPortfolio' && (
        <div>
          <PctField id={`${uid}-rate`} label="Share of savings spent each year" value={p.rate} lo={RULE_LIMITS.rate[0]} hi={RULE_LIMITS.rate[1]}
            onCommit={v => onChange({ ...rule, percent: { ...p, rate: v ?? p.rate } })} />
          <PctField id={`${uid}-floor`} label="Never below this much of your plan" value={p.floor} optional lo={RULE_LIMITS.floor[0]} hi={RULE_LIMITS.floor[1]}
            onCommit={v => onChange({ ...rule, percent: { ...p, floor: v, ceiling: v != null && p.ceiling != null && p.ceiling < v ? v : p.ceiling } })} />
          <PctField id={`${uid}-ceil`} label="Never above this much of your plan" value={p.ceiling} optional lo={RULE_LIMITS.ceiling[0]} hi={RULE_LIMITS.ceiling[1]}
            onCommit={v => onChange({ ...rule, percent: { ...p, ceiling: v != null && p.floor != null && v < p.floor ? p.floor : v } })} />
        </div>
      )}
      {cuts && (
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5, maxWidth: '72ch' }}>
          {cuts.anyCut === 0
            ? `In ${historical ? 'every past starting year' : 'every simulated future'}, spending never dropped below plan.`
            : `Deepest cut to everyday spending: ${whole(cuts.median)} in a typical ${historical ? 'starting year' : 'future'}, ${whole(cuts.worstTenth)} in the hardest tenth.`}
        </p>
      )}
    </div>
  );
}
