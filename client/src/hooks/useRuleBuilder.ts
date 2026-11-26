import { useCallback, useEffect, useState } from 'react';
import {
  combinedSpec, defaultSelection, isEmptySpec, toggleCondition,
  type RuleCondition, type RuleSpec, type RuleSubject,
} from '../lib/ruleConditions.ts';

// Loads the candidate rule conditions for one subject (a just-categorized
// transaction in the popup, the current merchant on a Quick review card), keeps
// which are ticked, and counts the combined (AND) match live.
//
// Every result is tagged with what it was asked for — the subject for the
// conditions, the exact selection for the count — and only shown while that is
// still current. So a slow response for an earlier card or an older selection can
// never stand in for the current one, even in the render before an effect cleans up.

export type RuleBuilderStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface RuleBuilder {
  status: RuleBuilderStatus;
  conds: RuleCondition[];
  sel: ReadonlySet<string>;
  spec: RuleSpec;            // the ticked conditions merged; {} when nothing is ticked
  count: number | null;      // combined matches for `sel`; null while counting or after a failed count
  countFailed: boolean;
  toggle: (key: string) => void;
}

interface Loaded { subject: RuleSubject; status: 'ready' | 'error'; conds: RuleCondition[]; sel: Set<string> }
interface Counted { sel: Set<string>; count: number | null; failed: boolean }
const NONE: ReadonlySet<string> = new Set();

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export function useRuleBuilder(subject: RuleSubject | null): RuleBuilder {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [counted, setCounted] = useState<Counted | null>(null);

  useEffect(() => {
    if (!subject) return;
    let alive = true;
    postJson<{ conditions?: RuleCondition[] }>('/api/budget/rule/suggest', subject)
      .then(d => {
        if (!alive) return;
        const conds = d.conditions ?? [];
        setLoaded({ subject, status: 'ready', conds, sel: defaultSelection(conds) });
      })
      .catch(() => { if (alive) setLoaded({ subject, status: 'error', conds: [], sel: new Set() }); });
    return () => { alive = false; };
  }, [subject]);

  const cur = subject && loaded?.subject === subject ? loaded : null;

  useEffect(() => {
    if (!cur || cur.status !== 'ready') return;
    const { sel } = cur;
    const spec = combinedSpec(cur.conds, sel);
    if (isEmptySpec(spec)) { setCounted({ sel, count: 0, failed: false }); return; }
    let alive = true;
    postJson<{ count?: number }>('/api/budget/rule/count', spec)
      .then(d => { if (alive) setCounted({ sel, count: d.count ?? 0, failed: false }); })
      .catch(() => { if (alive) setCounted({ sel, count: null, failed: true }); });
    return () => { alive = false; };
  }, [cur]);

  const toggle = useCallback((key: string) => {
    setLoaded(l => (l && l.subject === subject && l.status === 'ready' ? { ...l, sel: toggleCondition(l.conds, l.sel, key) } : l));
  }, [subject]);

  const sel = cur?.sel ?? NONE;
  const mine = counted && cur && counted.sel === cur.sel ? counted : null;
  return {
    status: !subject ? 'idle' : cur ? cur.status : 'loading',
    conds: cur?.conds ?? [],
    sel,
    spec: cur ? combinedSpec(cur.conds, sel) : {},
    count: mine ? mine.count : null,
    countFailed: !!mine?.failed,
    toggle,
  };
}
