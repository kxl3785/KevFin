import { useQuery } from '@tanstack/react-query';

// Data-fetching hook for GET endpoints, backed by TanStack Query. The contract
// is unchanged from the original hand-rolled version ({ data, loading, error,
// refetch }), so every consumer keeps working — but requests for the same URL
// are now deduped across components, results are cached across page
// navigations, and a global invalidation (see main.tsx's DATA_CHANGED_EVENT
// listener) refetches everything that's mounted.
export function useApi<T>(url: string, deps: unknown[] = []) {
  const query = useQuery<T>({
    queryKey: [url, ...deps],
    // React Query aborts this signal when the query is superseded or unmounted,
    // and discards results from stale requests — so a slow response can't
    // clobber a newer one after url/deps change.
    queryFn: async ({ signal }) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<T>;
    },
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    refetch: query.refetch,
  };
}
