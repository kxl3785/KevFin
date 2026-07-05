import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import { DATA_CHANGED_EVENT } from './components/Setup.tsx';
import './index.css';

// One query cache for the whole app. Defaults mirror the old hand-rolled
// useApi hook: no automatic retries, no refetch-on-focus — data changes when a
// mount, an explicit refetch, or a DATA_CHANGED_EVENT invalidation says so.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

// The Setup hub broadcasts this after anything that mutates server data
// (connect/remove institutions, sync, backfill, import, restore). Invalidate
// everything: every mounted useApi query refetches, so each page reflects the
// change without page-level event plumbing.
window.addEventListener(DATA_CHANGED_EVENT, () => {
  queryClient.invalidateQueries();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
