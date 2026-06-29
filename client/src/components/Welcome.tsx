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

// Page 2 — how to obtain the keys/tokens each connection needs. KevFin uses YOUR
// own provider credentials, so the data path stays yours end-to-end. Steps mirror
// the in-app flows: ConnectPlaid ("+ Plaid"), ConnectSimpleFIN ("+ SimpleFIN"),
// and ClaudeLoginGate (the AI login panel).
const CONNECTIONS: {
  icon: string;
  title: string;
  cost: string;
  body: string;
  steps: string[];
  link?: { href: string; label: string };
}[] = [
  {
    icon: '🏦',
    title: 'Plaid',
    cost: 'Free developer signup',
    body: 'Links most banks and brokerages. KevFin connects with your own Plaid production keys, so the connection belongs to you.',
    steps: [
      'Create a free Plaid developer account, then request production access (Plaid grants it for personal use).',
      'In the Plaid dashboard, open Developers → Keys and copy your Client ID and your production Secret.',
      'In KevFin, open Setup (⚙) → click “+ Plaid”, paste both keys, and Save — then choose your institution in the window that opens.',
    ],
    link: { href: 'https://dashboard.plaid.com/developers/keys', label: 'Get your Plaid keys →' },
  },
  {
    icon: '🔗',
    title: 'SimpleFIN',
    cost: 'Low-cost subscription',
    body: 'A simple aggregator that often reaches accounts Plaid does not. You connect it with a one-time setup token.',
    steps: [
      'Create a SimpleFIN Bridge account (a small subscription fee) and link your banks there.',
      'On your SimpleFIN account page, generate a new setup token and copy it.',
      'In KevFin, open Setup (⚙) → click “+ SimpleFIN”, paste the token, and Connect.',
    ],
    link: { href: 'https://beta-bridge.simplefin.org/my-account', label: 'Get a SimpleFIN setup token →' },
  },
  {
    icon: '🤖',
    title: 'AI assistant',
    cost: 'Uses your Claude subscription — no API key',
    body: 'Optional. Powers the chat assistant and document import. It runs a locally-installed Claude Code on your own Claude subscription and only ever sees a compact financial summary — never your files.',
    steps: [
      'Install Claude Code on this computer (or point the server at it by setting CLAUDE_BIN in server/.env).',
      'Open any AI feature in KevFin and click “Log in to Claude”, then type /login in the terminal that opens.',
      'On Windows — or any OS — you can instead run “claude setup-token” in a terminal and paste the token into the login panel.',
    ],
    link: { href: 'https://docs.claude.com/en/docs/claude-code/overview', label: 'Install Claude Code →' },
  },
];

export default function Welcome() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(SEEN_KEY) !== '1'; } catch { return true; }
  });
  const [page, setPage] = useState(0); // 0 = overview, 1 = connection setup

  // Reopen on demand when Setup asks (the "Show welcome guide" button).
  useEffect(() => {
    function onShow() { setPage(0); setOpen(true); }
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
        {page === 0 ? (
          <>
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

            <button className="btn-primary" onClick={() => setPage(1)}
              style={{ width: '100%', marginTop: 22, fontSize: 15, fontWeight: 600, padding: '12px 16px' }}>
              Next: connect your data →
            </button>
            <button onClick={dismiss}
              style={{ display: 'block', margin: '10px auto 0', background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}>
              Skip for now
            </button>
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }} aria-hidden>🔌</div>
              <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px' }}>Set up your connections</h2>
              <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 6, lineHeight: 1.5 }}>
                These are optional and use <strong>your own</strong> accounts and keys, so your data never
                leaves this computer. Add one now or anytime from Setup (⚙).
              </p>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {CONNECTIONS.map((c, i) => (
                <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 24, lineHeight: 1.1, flex: '0 0 auto' }} aria-hidden>{c.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <p style={{ fontSize: 14, fontWeight: 700 }}>{c.title}</p>
                        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>{c.cost}</span>
                      </div>
                      <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: 3 }}>{c.body}</p>
                      <ol style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, margin: '8px 0 0', paddingLeft: 18 }}>
                        {c.steps.map((step, j) => <li key={j} style={{ marginBottom: 2 }}>{step}</li>)}
                      </ol>
                      {c.link && (
                        <a href={c.link.href} target="_blank" rel="noreferrer"
                          style={{ display: 'inline-block', marginTop: 8, fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
                          {c.link.label}
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
              <button className="btn-ghost" onClick={() => setPage(0)}
                style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 600, padding: '12px 18px' }}>
                ← Back
              </button>
              <button className="btn-primary" onClick={dismiss}
                style={{ flex: 1, fontSize: 15, fontWeight: 600, padding: '12px 16px' }}>
                Get started
              </button>
            </div>
          </>
        )}

        <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, marginTop: 10 }}>
          You can reopen this guide anytime from Setup (the ⚙ gear, top-right).
        </p>
      </div>
    </div>
  );
}
