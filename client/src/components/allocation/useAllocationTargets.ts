import { useCallback, useMemo } from 'react';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import {
  DEFAULT_TARGETS_PREF, TARGETS_PREF_KEY, normalizeTargetsPref, type AllocTargetsPref,
} from '../../lib/allocationTargets.ts';

// Shared access to the saved target settings (custom targets, which set of
// targets is in use, and the tolerance band). Every hook bound to the key stays
// in sync, so the Asset allocation chart and the rebalancing worksheet always
// agree. The stored value is cleaned on every read, so a hand-edited or older
// setting can't break the page.
export function useAllocationTargets() {
  const [raw, setRaw] = usePersistentState<AllocTargetsPref>(TARGETS_PREF_KEY, DEFAULT_TARGETS_PREF);
  const pref = useMemo(() => normalizeTargetsPref(raw), [raw]);
  const update = useCallback(
    (patch: Partial<AllocTargetsPref>) => setRaw(prev => ({ ...normalizeTargetsPref(prev), ...patch })),
    [setRaw],
  );
  return { pref, update };
}
