import { useEffect, useState } from 'react';

// First-run welcome / onboarding overlay, aimed at non-technical users. It shows
// automatically the first time KevFin is opened on a machine, and can be reopened
// any time from Setup (which dispatches SHOW_WELCOME_EVENT).
export const SHOW_WELCOME_EVENT = 'kevfin:show-welcome';

// localStorage flag set once the guide is dismissed, so it only auto-appears on
// the very first visit. Lives under the same `mon.` prefix the rest of the app
// uses, so it's captured by backups.
const SEEN_KEY = 'mon.welcomeSeen';

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: '🔒',
    title: 'Your data stays private',
    body: 'KevFin runs entirely on this computer. Your accounts, balances, and transactions are stored locally — they are never sent to anyone.',
  },
  {
    icon: '🔗',
    title: 'Connect your accounts',
    body: 'Open Setup (the ⚙ gear, top-right) to link your banks and brokerages, or add real estate and other assets by hand.',
  },
  {
    icon: '📊',
    title: 'Explore your finances',
    body: 'Use the tabs at the top: Dashboard for net worth, Investments for allocation, Budget for spending, and Forecast to project your retirement.',
  },
  {
    icon: '💾',
    title: 'Keep a backup',
    body: 'In Setup → Download backup, save a copy of everything — your data and settings — somewhere safe. You can restore it later or on another computer.',
  },
];

export default function Welcome() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(SEEN_KEY) !== '1'; } catch { return true; }
  });

  // Reopen on demand when Setup asks (the "Show welcome guide" button).
  useEffect(() => {
    function onShow() { setOpen(true); }
    window.addEventListener(SHOW_WELCOME_EVENT, onShow);
    return () => window.removeEventListener(SHOW_WELCOME_EVENT, onShow);
  }, []);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') dismiss(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function dismiss() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore quota */ }
    setOpen(false);
  }

  if (!open) return null;
  return (
    <div onClick={dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 3500,
        background: 'rgba(0,0,0,0.6)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center',
        padding: '6vh 16px 16px', overflowY: 'auto',
      }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Welcome to KevFin"
        style={{
          width: '100%', maxWidth: 560,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 16, boxShadow: '0 16px 48px rgba(0,0,0,0.55)', padding: 28,
        }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }} aria-hidden>👋</div>
          <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.5px' }}>Welcome to KevFin</h2>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>
            Your private net-worth tracker — banks, investments, real estate, budgeting, and a
            retirement forecast, all in one place that runs on your own computer.
          </p>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
              <div style={{ fontSize: 24, lineHeight: 1.1, flex: '0 0 auto' }} aria-hidden>{s.icon}</div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>{s.title}</p>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <button className="btn-primary" onClick={dismiss}
          style={{ width: '100%', marginTop: 22, fontSize: 15, fontWeight: 600, padding: '12px 16px' }}>
          Get started
        </button>
        <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>
          You can reopen this guide anytime from Setup (the ⚙ gear, top-right).
        </p>
      </div>
    </div>
  );
}
