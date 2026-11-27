import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard.tsx';
import Allocation from './pages/Allocation.tsx';
import Budget from './pages/Budget.tsx';
import Forecast from './pages/Forecast.tsx';
import ReportView from './pages/ReportView.tsx';
import type { View } from './components/TopNav.tsx';
import AiAssistant from './components/AiAssistant.tsx';
import Welcome from './components/Welcome.tsx';
import { OPEN_CONNECTIONS_EVENT } from './lib/openConnections.ts';
import { usePersistentState } from './hooks/usePersistentState.ts';
import { useTheme } from './hooks/useTheme.ts';

// The app shell: routes, the privacy toggle shared by every page, and the AI
// assistant (mounted once alongside the pages so its conversation persists as
// the user moves between sections). Each section is a real URL now, so
// back/forward and bookmarks work; pages still receive the same
// onNavigate/privacy props they always did.

const PATHS: Record<View, string> = {
  dashboard: '/',
  allocation: '/allocation',
  budget: '/budget',
  forecast: '/forecast',
};

function viewForPath(pathname: string): View {
  if (pathname.startsWith('/allocation')) return 'allocation';
  if (pathname.startsWith('/budget')) return 'budget';
  if (pathname.startsWith('/forecast')) return 'forecast';
  return 'dashboard';
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewForPath(location.pathname);
  // The quarterly report view is a page of its own rather than a nav section; the
  // assistant is told when it is open so it can answer about the report.
  const onReport = location.pathname.startsWith('/report');
  const [privacy, setPrivacy] = usePersistentState('mon.privacy', false);
  useTheme(); // keeps <html data-theme> in step with the Appearance setting
  // Lets CSS mask what components can't (typed figures in inputs) in privacy mode.
  useEffect(() => { document.documentElement.classList.toggle('privacy-mode', privacy); }, [privacy]);

  // Navigating between sections should land at the top, not wherever the
  // previous page was scrolled.
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  // Name the browser tab after the section (it read "KevFin — Net Worth" everywhere).
  useEffect(() => {
    const titles: Record<View, string> = {
      dashboard: 'Net Worth', allocation: 'Investments', budget: 'Budget', forecast: 'Forecast',
    };
    document.title = `KevFin — ${onReport ? 'Quarterly report' : titles[view]}`;
  }, [view, onReport]);

  // The welcome guide's "Connect an account" asks for the Dashboard's Connect
  // panel; from another section, switch to the Dashboard, which then opens it
  // (lib/openConnections.ts).
  useEffect(() => {
    function onOpenConnections() { if (view !== 'dashboard' || onReport) navigate(PATHS.dashboard); }
    window.addEventListener(OPEN_CONNECTIONS_EVENT, onOpenConnections);
    return () => window.removeEventListener(OPEN_CONNECTIONS_EVENT, onOpenConnections);
  }, [view, onReport, navigate]);

  const pageProps = {
    onNavigate: (v: View) => navigate(PATHS[v]),
    privacy,
    onTogglePrivacy: () => setPrivacy(p => !p),
  };

  return (
    <>
      <Routes>
        <Route path="/" element={<Dashboard {...pageProps} />} />
        <Route path="/allocation" element={<Allocation {...pageProps} />} />
        <Route path="/budget" element={<Budget {...pageProps} />} />
        <Route path="/forecast" element={<Forecast {...pageProps} />} />
        <Route path="/report" element={<ReportView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <AiAssistant view={onReport ? 'report' : view} />
      <Welcome />
    </>
  );
}
