import { useState, useEffect, useCallback, useRef } from 'react';

export function useApi<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The controller of the latest request. Aborting the previous one on each
  // refetch (and checking identity before setState) keeps a slow, stale
  // response from clobbering the data of a newer request after url/deps change.
  const ctrlRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (ctrlRef.current === ctrl) setData(json);
    } catch (e) {
      if (ctrl.signal.aborted) return; // superseded or unmounted — not an error
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (ctrlRef.current === ctrl) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  useEffect(() => {
    refetch();
    return () => ctrlRef.current?.abort();
  }, [refetch]);

  return { data, loading, error, refetch };
}
