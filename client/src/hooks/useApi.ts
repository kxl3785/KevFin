import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { servedFrom, pollDelay, type Served } from '../lib/served.ts';

// What the query cache holds for a URL: the response body, plus what the server
// said about it (see lib/served.ts). `polls` counts the answers in a row that
// said "a newer one is being computed", to space out the re-asks.
interface Envelope<T> { body: T; served: Served | null; polls: number }

// Data-fetching hook for GET endpoints, backed by TanStack Query. The contract
// is unchanged from the original hand-rolled version ({ data, loading, error,
// refetch }), so every consumer keeps working — but requests for the same URL
// are now deduped across components, results are cached across page
// navigations, and a global invalidation (see main.tsx's DATA_CHANGED_EVENT
// listener) refetches everything that's mounted.
//
// Some endpoints (the Investments ones) answer from a stored result and say so
// in response headers. `served` carries that: when the result was computed and
// whether the server is computing a newer one. While it is, the hook asks again
// by itself, keeping the current data on screen until the new one arrives.
//
// `keepPrevious`: when the URL changes, keep showing the last URL's data (with
// `loading` false) until the new one arrives, instead of going back to empty.
export function useApi<T>(url: string, deps: unknown[] = [], opts: { keepPrevious?: boolean } = {}) {
  const client = useQueryClient();
  const queryKey = [url, ...deps];
  const query = useQuery<Envelope<T>>({
    queryKey,
    // React Query aborts this signal when the query is superseded or unmounted,
    // and discards results from stale requests — so a slow response can't
    // clobber a newer one after url/deps change.
    queryFn: async ({ signal }) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as T;
      const served = servedFrom(res.headers);
      const before = client.getQueryData<Envelope<T>>(queryKey);
      return { body, served, polls: served?.refreshing ? (before?.served?.refreshing ? before.polls + 1 : 0) : 0 };
    },
    refetchInterval: q => (q.state.data?.served?.refreshing ? pollDelay(q.state.data.polls) : false),
    ...(opts.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });

  return {
    data: query.data ? query.data.body : null,
    loading: query.isPending,
    error: query.error ? query.error.message : null,
    refetch: query.refetch,
    served: query.data?.served ?? null,
  };
}
