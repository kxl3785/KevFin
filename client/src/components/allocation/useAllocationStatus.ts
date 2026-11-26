import { useMemo } from 'react';
import { ASSET_CLASS_META, type RiskProfile } from '../../lib/riskProfiles.ts';
import { effectiveTargets } from '../../lib/allocationTargets.ts';
import { rebalance, type RebalanceResult } from '../../lib/rebalance.ts';
import { useAllocationTargets } from './useAllocationTargets.ts';

// The allocation measured against the targets in use, computed once for the
// page: the "Off target" headline tile and the allocation card's bars both read
// this, and the rebalance worksheet runs the same rebalance() on the same
// values, so all three always agree. Only the kinds the targets cover are
// compared (renormalised to 100% of themselves); real estate and other assets
// sit outside the targets.

export const META_KEYS = ASSET_CLASS_META.map(m => m.key as string);

export interface AllocationStatus {
  // Dollars per targeted kind (classes outside the targets are left out).
  values: Record<string, number>;
  model: Record<string, number> | null;
  source: 'custom' | 'profile' | null;
  band: number;
  result: RebalanceResult | null;
}

export function useAllocationStatus(classes: { name: string; value: number }[], riskProfile: RiskProfile | null): AllocationStatus {
  const { pref } = useAllocationTargets();
  const { model, source } = effectiveTargets(pref, riskProfile);
  const band = pref.band;
  return useMemo(() => {
    const values: Record<string, number> = {};
    for (const c of classes) if (META_KEYS.includes(c.name)) values[c.name] = (values[c.name] ?? 0) + c.value;
    const result = model ? rebalance(values, model, band, META_KEYS) : null;
    return { values, model, source, band, result };
    // model is a fresh object per render only when targets change shape; key on its content.
  }, [classes, JSON.stringify(model), source, band]); // eslint-disable-line react-hooks/exhaustive-deps
}
