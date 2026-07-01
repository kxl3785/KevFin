import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { hydrateSettings } from './lib/settingsSync.ts';

// Pull the server-persisted client settings into localStorage before the first
// render, so usePersistentState reads the user's saved Forecast/budget inputs
// (which sync across devices via the NAS DB) instead of defaults. Best-effort:
// if the server is unreachable we render with whatever is stored locally.
hydrateSettings().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
