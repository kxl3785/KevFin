import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
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

// Root error boundary: without one, a throw in any component unmounts the whole
// tree and leaves a blank page. Show the error text so it can be reported/reloaded.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Unhandled render error', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: '10vh auto', fontFamily: 'system-ui, sans-serif', color: 'var(--text)' }}>
        <h2 style={{ marginBottom: 8 }}>Something went wrong — reload</h2>
        <p style={{ color: 'var(--muted)', fontSize: 14, wordBreak: 'break-word' }}>{this.state.error.message}</p>
        <button onClick={() => window.location.reload()} style={{ marginTop: 12 }}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);
