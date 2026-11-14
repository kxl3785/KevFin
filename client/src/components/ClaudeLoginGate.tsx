import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import AssistantPrivacyNote from './AssistantPrivacy.tsx';

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
// What the status call also reports about this installation: which model answers,
// and what the sign-in screen needs to show the right steps here.
export interface AssistantInfo {
  modelLabel: string | null;
  runMode: string | null;          // 'desktop app' | 'Docker container' | 'from source'
  canOpenTerminal: boolean;        // the server can open a Terminal running Claude (macOS, not a container)
  tokenCommand: string;            // the exact `setup-token` command for this installation
}
interface AuthSnap { status: ClaudeAuth; command: string | null; info: AssistantInfo | null }
let snap: AuthSnap = { status: 'ok', command: null, info: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function setSnap(next: { status: ClaudeAuth; command: string | null; info?: AssistantInfo | null }) {
  const info = next.info === undefined ? snap.info : next.info; // keep the last-known info unless given
  if (next.status === snap.status && next.command === snap.command && JSON.stringify(info) === JSON.stringify(snap.info)) return; // no-op, skip re-render
  snap = { status: next.status, command: next.command, info }; emit();
}

function readInfo(data: Record<string, unknown>): AssistantInfo | undefined {
  if (typeof data.tokenCommand !== 'string') return undefined; // an older server: keep what we have
  return {
    modelLabel: typeof data.modelLabel === 'string' ? data.modelLabel : null,
    runMode: typeof data.runMode === 'string' ? data.runMode : null,
    canOpenTerminal: data.canOpenTerminal === true,
    tokenCommand: data.tokenCommand,
  };
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
    else if (data.binaryFound === false) setSnap({ status: 'no_binary', command: null, info: readInfo(data) });
    else if (data.loggedIn === false) setSnap({ status: 'logged_out', command: data.command ?? null, info: readInfo(data) });
    else setSnap({ status: 'ok', command: null, info: readInfo(data) }); // logged in, or unknown — proceed
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
  return { status: s.status, command: s.command, recheck, info: s.info };
}

// The name of the model that answers ("Claude Opus 5.5"), once the status call has
// reported it; null before that or against an older server.
export function useAssistantModel(): string | null {
  return useSyncExternalStore(subscribe, () => snap.info?.modelLabel ?? null);
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

// One numbered step of the sign-in screen.
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span aria-hidden="true" style={{
        flex: 'none', width: 20, height: 20, borderRadius: '50%', marginTop: 1,
        background: 'var(--accent-dim)', color: 'var(--accent)',
        fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}>{children}</div>
    </li>
  );
}

function CommandLine({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px' }}>
      <code style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text)', overflowX: 'auto', whiteSpace: 'nowrap' }}>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * The screen that turns the AI features on, shown before any AI use when the
 * Claude binary isn't signed in. Two ways, as numbered steps, with the one that
 * works on this installation first:
 *  - "window": the server opens a Terminal running the exact binary and the user
 *    types /login there (macOS, when not in a container);
 *  - "token": run `claude setup-token` and paste the result — the only way in a
 *    container or on Windows/Linux, and always available as the alternative.
 */
export function ClaudeLoginPrompt({ command, noBinary, onRecheck, compact }: {
  command: string | null;
  noBinary?: boolean;
  onRecheck: () => Promise<void>;
  compact?: boolean; // tighter layout for the narrow assistant panel
}) {
  const info = useSyncExternalStore(subscribe, () => snap.info);
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [stillOut, setStillOut] = useState(false);
  const [token, setToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [chosen, setChosen] = useState<'window' | 'token' | null>(null);

  // Until the server has said otherwise, assume a Terminal can be opened (the
  // behaviour before it reported this).
  const canOpen = info ? info.canOpenTerminal : true;
  const way = chosen ?? (canOpen ? 'window' : 'token');
  const inContainer = info?.runMode === 'Docker container';
  const tokenCommand = info?.tokenCommand ?? 'claude setup-token';

  // If the gate is still on screen after a re-check, the check found no sign-in.
  const recheck = async () => {
    setRechecking(true); setStillOut(false);
    try { await onRecheck(); setStillOut(true); } finally { setRechecking(false); }
  };

  // Save a setup token (from `claude setup-token`) so the assistant runs on the
  // user's own subscription. It is posted to this app's own server only.
  async function saveToken() {
    const t = token.trim();
    if (!t) return;
    setSavingToken(true); setTokenMsg(null); setStillOut(false);
    try {
      const res = await fetch('/api/assistant/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not save the token.');
      setToken(''); setTokenMsg('Saved. Ask a question to check that it works.');
      await onRecheck();
    } catch (e) {
      setTokenMsg(e instanceof Error ? e.message : 'Could not save the token.');
    } finally {
      setSavingToken(false);
    }
  }

  async function openLogin() {
    setOpening(true); setStillOut(false);
    setLoginMsg('Opening Terminal…');
    try {
      const res = await fetch('/api/assistant/login', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Could not open a terminal.');
      setLoginMsg('Terminal is open. Continue with step 2.');
    } catch (e) {
      setLoginMsg(e instanceof Error ? e.message : 'Could not open a terminal.');
      setChosen('token'); // fall back to the way that needs no Terminal helper
    } finally {
      setOpening(false);
    }
  }

  if (noBinary) {
    const bundled = info?.runMode === 'desktop app' || inContainer;
    return (
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        <p style={{ color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>Claude Code is missing</p>
        {bundled
          ? <>The AI features use the Claude Code program that ships with KevFin, and it could not be found. Reinstalling or updating KevFin puts it back; your data is not affected.</>
          : <>The AI features use the Claude Code program, which is not installed on this computer. <a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Install Claude Code</a>, then check again. (If it is installed somewhere unusual, set <code>CLAUDE_BIN</code> in <code>server/.env</code>.)</>}
        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={recheck} disabled={rechecking} style={{ fontSize: 12, padding: '6px 12px' }}>
            {rechecking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    );
  }

  const switchLink = (to: 'window' | 'token', label: string) => (
    <button type="button" onClick={() => { setChosen(to); setStillOut(false); }}
      style={{ background: 'none', padding: 0, fontSize: 12, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', borderRadius: 0 }}
    >{label}</button>
  );

  return (
    <div>
      <p style={{ fontSize: compact ? 13.5 : 14, color: 'var(--text)', lineHeight: 1.4, marginBottom: 4, fontWeight: 600 }}>
        Turn on the AI assistant
      </p>
      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 12 }}>
        It runs on your own Claude subscription, so there is no API key and no extra charge. Sign in once{way === 'window' ? '' : ' with a setup token'}:
      </p>

      {way === 'window' ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Step n={1}>
            <button className="btn-primary" onClick={openLogin} disabled={opening} style={{ padding: '7px 14px', fontSize: 13 }}>
              {opening ? 'Opening…' : 'Open the sign-in window'}
            </button>
            {loginMsg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{loginMsg}</div>}
            {command && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Or run this in a terminal yourself:
                <CommandLine text={command} />
              </div>
            )}
          </Step>
          <Step n={2}>In that window, type <code>/login</code>, press Return, and approve in your browser.</Step>
          <Step n={3}>
            <button className="btn-ghost" onClick={recheck} disabled={rechecking} style={{ padding: '7px 12px', fontSize: 13 }}>
              {rechecking ? 'Checking…' : 'I’ve signed in'}
            </button>
          </Step>
        </ol>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Step n={1}>
            {inContainer
              ? 'On any computer that has Claude Code installed, run this in a terminal:'
              : 'Run this in a terminal on this computer:'}
            <CommandLine text={tokenCommand} />
          </Step>
          <Step n={2}>Approve in the browser window it opens, then copy the token it prints.</Step>
          <Step n={3}>
            Paste the token here:
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="password" value={token} onChange={e => setToken(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void saveToken(); }}
                placeholder="Setup token" autoComplete="off" aria-label="Claude setup token"
                style={{ flex: 1, minWidth: 0, padding: '6px 8px' }} />
              <button className="btn-primary" onClick={saveToken} disabled={savingToken || !token.trim()}
                style={{ fontSize: 13, padding: '7px 12px', flexShrink: 0 }}>
                {savingToken ? 'Saving…' : 'Turn on'}
              </button>
            </div>
            {tokenMsg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{tokenMsg}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
              It is saved in KevFin’s keys file on {inContainer ? 'your server (in the data folder, so it survives updates)' : 'this computer'} and is only used to sign Claude in.
            </div>
          </Step>
        </ol>
      )}

      {stillOut && (
        <div role="status" style={{ fontSize: 12, color: 'var(--red)', marginTop: 10, lineHeight: 1.5 }}>
          Claude still isn’t signed in. {way === 'window' ? 'Finish /login in the Terminal window, then try again.' : 'Check the token was copied in full, then try again.'}
        </div>
      )}

      <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10, fontSize: 12, color: 'var(--muted)' }}>
        {way === 'window'
          ? <>No Terminal, or on another computer? {switchLink('token', 'Use a setup token instead')}</>
          : canOpen
            ? <>On this Mac? {switchLink('window', 'Sign in from a Terminal window instead')}</>
            : <>No Claude subscription? The rest of KevFin works without the assistant.</>}
      </div>

      {/* Said before they turn it on, not after. */}
      <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <AssistantPrivacyNote align="left" />
      </div>
    </div>
  );
}
