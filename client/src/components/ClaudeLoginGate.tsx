import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';

// Login state of the Claude binary the server uses for AI features.
//   ok         — logged in (also the optimistic default before/while a check runs)
//   logged_out — needs /login
//   no_binary  — Claude Code isn't installed / resolvable
export type ClaudeAuth = 'ok' | 'logged_out' | 'no_binary';

// --- Shared auth store -----------------------------------------------------
// One login check, shared across every AI surface (assistant, import). Clicking
// the Upload or AI button re-checks login every time, but in the BACKGROUND: the
// surface opens immediately on the last-known state and only flips to the login
// gate if the fresh check finds you logged out. So we never show a blocking
// "checking" screen — the status simply starts optimistic ('ok') and corrects.
interface AuthSnap { status: ClaudeAuth; command: string | null }
let snap: AuthSnap = { status: 'ok', command: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function setSnap(s: AuthSnap) {
  if (s.status === snap.status && s.command === snap.command) return; // no-op, skip re-render
  snap = s; emit();
}

// Read the server's known login state. `reset` (the gate's "I've logged in")
// forgets the prior result so we proceed optimistically and the next real call
// reconfirms. Background: don't flip to a "checking" state — keep the last-known
// status and update only when the result arrives.
async function runCheck(reset: boolean) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`/api/assistant/status${reset ? '?recheck=1' : ''}`, { signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) setSnap({ status: 'ok', command: null });
    else if (data.binaryFound === false) setSnap({ status: 'no_binary', command: null });
    else if (data.loggedIn === false) setSnap({ status: 'logged_out', command: data.command ?? null });
    else setSnap({ status: 'ok', command: null }); // logged in, or unknown — proceed
  } catch {
    /* timeout or network hiccup — keep the last-known status, don't block */
  } finally {
    clearTimeout(timeout);
  }
}

// Sync the known login state. Call from the onClick of any control that brings up
// an AI surface (Upload / AI button) so a previously-established logged-out state
// shows the gate up front. Background; an in-flight check is reused.
export function prefetchClaudeAuth(): Promise<void> {
  if (!inflight) inflight = runCheck(false).finally(() => { inflight = null; });
  return inflight;
}

// Re-check after the user says they logged in: forget the prior result and
// proceed optimistically (the next real call reconfirms).
function recheckClaudeAuth(): Promise<void> {
  inflight = runCheck(true).finally(() => { inflight = null; });
  return inflight;
}

// Current login status outside of React (e.g. to gate an upload before starting).
export function getClaudeAuth(): ClaudeAuth { return snap.status; }

// Drive the gate directly from a real call's outcome — the reliable signal. A
// chat/upload that fails as "not logged in" calls reportLoggedOut(); a successful
// one calls reportLoggedIn(). This is how the gate appears, since we no longer
// run a speculative probe.
export function reportLoggedOut(command?: string | null) {
  setSnap({ status: 'logged_out', command: command ?? snap.command ?? null });
}
export function reportLoggedIn() { setSnap({ status: 'ok', command: null }); }

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

// Subscribe to the shared auth state. `active` (the panel being open) re-checks
// as a fallback for surfaces opened without a button click (e.g. a dropped file).
export function useClaudeAuth(active: boolean) {
  const s = useSyncExternalStore(subscribe, () => snap);
  useEffect(() => { if (active) void prefetchClaudeAuth(); }, [active]);
  const recheck = useCallback(() => recheckClaudeAuth(), []);
  return { status: s.status, command: s.command, recheck };
}

// Copies `text` to the clipboard and briefly flips its label to "Copied".
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-ghost"
      style={{ fontSize: 11, padding: '4px 10px', flexShrink: 0 }}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
      }}
    >{copied ? 'Copied ✓' : 'Copy'}</button>
  );
}

/**
 * The login screen shown before any AI use when the Claude binary isn't logged
 * in. "Log in to Claude" opens a terminal running the exact binary; the user
 * types /login there, then hits "I've logged in" to re-check.
 */
export function ClaudeLoginPrompt({ command, noBinary, onRecheck, compact }: {
  command: string | null;
  noBinary?: boolean;
  onRecheck: () => Promise<void>;
  compact?: boolean; // tighter layout for the narrow assistant panel
}) {
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [token, setToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const recheck = async () => { setRechecking(true); try { await onRecheck(); } finally { setRechecking(false); } };

  // Cross-platform sign-in: save a setup token (from `claude setup-token`) so the
  // assistant runs on the user's own subscription — the path that works on
  // Windows, where the Terminal helper doesn't.
  async function saveToken() {
    const t = token.trim();
    if (!t) return;
    setSavingToken(true); setTokenMsg(null);
    try {
      const res = await fetch('/api/assistant/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save the token.');
      setToken(''); setTokenMsg('Saved — checking…');
      await onRecheck();
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Could not save the token.');
    } finally {
      setSavingToken(false);
    }
  }

  async function openLogin() {
    setOpening(true);
    setLoginMsg('Opening Terminal…');
    try {
      const res = await fetch('/api/assistant/login', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not open a terminal.');
      setLoginMsg('Terminal opened — type /login there, then come back and re-check.');
    } catch (e) {
      setLoginMsg(e instanceof Error ? e.message : 'Could not open a terminal. Run the command below by hand.');
    } finally {
      setOpening(false);
    }
  }

  if (noBinary) {
    return (
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Claude Code wasn’t found on this machine. Install it (or set <code>CLAUDE_BIN</code> in <code>server/.env</code>) to use the AI features, then re-check.
        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={recheck} disabled={rechecking} style={{ fontSize: 12, padding: '6px 12px' }}>
            {rechecking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: compact ? 13 : 13.5, color: 'var(--text)', lineHeight: 1.5, marginBottom: 4, fontWeight: 600 }}>
        Log in to Claude to use AI features
      </p>
      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 12 }}>
        The assistant and document import run on your Claude subscription, but the Claude this app uses isn’t logged in yet.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn-primary" onClick={openLogin} disabled={opening} style={{ padding: '8px 14px' }}>
          {opening ? 'Opening…' : 'Log in to Claude'}
        </button>
        <button className="btn-ghost" onClick={recheck} disabled={rechecking} style={{ padding: '8px 12px', fontSize: 13 }}>
          {rechecking ? 'Checking…' : 'I’ve logged in'}
        </button>
      </div>
      {loginMsg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{loginMsg}</div>}
      {command && (
        <>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, marginBottom: 4 }}>Or run this yourself, then type <code>/login</code>:</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px' }}>
            <code style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text)', overflowX: 'auto', whiteSpace: 'nowrap' }}>{command}</code>
            <CopyButton text={command} />
          </div>
        </>
      )}
      {/* Cross-platform sign-in: paste a setup token. Works on any OS. */}
      <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.5 }}>
          Or paste a setup token (works on any OS) — get one by running <code>claude setup-token</code>:
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="password" value={token} onChange={e => setToken(e.target.value)}
            placeholder="Paste setup token" autoComplete="off"
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '6px 8px' }} />
          <button className="btn-ghost" onClick={saveToken} disabled={savingToken || !token.trim()}
            style={{ fontSize: 12, padding: '6px 12px', flexShrink: 0 }}>
            {savingToken ? 'Saving…' : 'Save'}
          </button>
        </div>
        {tokenMsg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{tokenMsg}</div>}
      </div>
    </div>
  );
}
