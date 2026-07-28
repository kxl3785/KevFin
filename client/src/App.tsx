import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard.tsx';
import Allocation from './pages/Allocation.tsx';
import Budget from './pages/Budget.tsx';
import Forecast from './pages/Forecast.tsx';
import type { View } from './components/TopNav.tsx';
import AiAssistant from './components/AiAssistant.tsx';
import Welcome from './components/Welcome.tsx';
import { usePersistentState } from './hooks/usePersistentState.ts';

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
  const [privacy, setPrivacy] = usePersistentState('mon.privacy', false);

  // Navigating between sections should land at the top, not wherever the
  // previous page was scrolled.
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <AiAssistant view={view} />
      <Welcome />
    </>
  );
}
