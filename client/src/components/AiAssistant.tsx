import { memo, useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { type View } from './TopNav.tsx';
import { IMPORT_FILE_EVENT } from './DocImport.tsx';
import { useClaudeAuth, ClaudeLoginPrompt, prefetchClaudeAuth, reportLoggedIn, reportLoggedOut } from './ClaudeLoginGate.tsx';
import AssistantChart from './AssistantChart.tsx';
import AssistantActionCard, { type ActionState } from './AssistantActionCard.tsx';
import { splitMessage } from '../lib/assistantChart.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { FORECAST_CHANGED_KEY } from '../lib/forecastEdit.ts';

// The panel's open state and the unsent draft, kept for this browser tab
// (sessionStorage) so the assistant is still open, with what you were typing,
// after a reload — it already stays put while you move between the top tabs,
// because it is mounted once beside the pages. Per tab rather than per browser:
// a panel left open yesterday shouldn't pop up over the dashboard in a new tab.
const OPEN_KEY = 'kevfin.assistant.open';
const DRAFT_KEY = 'kevfin.assistant.draft';
function readSession(key: string): string {
  try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writeSession(key: string, value: string) {
  try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* not kept; fine */ }
}

// Whether the chat panel is in its larger size. A per-browser choice (a big panel
// suits a desktop monitor, not necessarily the phone that shares the same server),
// so it lives in localStorage only rather than the server-synced prefs. Storage
// can be unavailable (private mode, blocked site data) — the panel then simply
// opens at its normal size.
const LARGE_KEY = 'kevfin.assistant.large';
function readLarge(): boolean {
  try { return localStorage.getItem(LARGE_KEY) === '1'; } catch { return false; }
}
function writeLarge(large: boolean) {
  try { localStorage.setItem(LARGE_KEY, large ? '1' : '0'); } catch { /* not persisted; still applies now */ }
}

// Outward arrows to enlarge, inward to shrink.
function SizeIcon({ large }: { large: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {large
        ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}

// `actions` records what the user did with each change the assistant proposed in
// this message (keyed by the card's position in it), so a card stays "Applied" or
// "Dismissed" across reloads instead of offering itself again.
interface Message { role: 'user' | 'assistant'; content: string; actions?: Record<number, ActionState> }

// Where the assistant is being used: one of the app's sections, or the in-app
// quarterly report view (which is a page of its own, not a nav section).
type AssistantView = View | 'report';

// The conversation as sent to the server: text only. What the user did with a
// proposed change is appended to that answer, so on the next turn the assistant
// knows whether its suggestion was applied rather than assuming either way.
function toWire(messages: Message[]): { role: Message['role']; content: string }[] {
  return messages.map(m => {
    const notes = Object.values(m.actions ?? {}).map(a =>
      a.status === 'applied' ? `[The user applied a proposed change: ${a.done ?? 'done'}]` : '[The user dismissed a proposed change; it was not applied.]');
    return { role: m.role, content: notes.length ? `${m.content}\n\n${notes.join('\n')}` : m.content };
  });
}

// The Forecast (retirement Monte Carlo) lives entirely in the browser, so its
// inputs and computed summary aren't on the server. Collect them from localStorage
// to ship with the chat request, so the assistant can field planning questions.
// (Account balances and budget are already server-side and exported separately.)
function readForecastContext(): Record<string, unknown> | undefined {
  const read = (key: string) => { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; } };
  const forecast = {
    assumptions: read('mon.fcAssumptions'),
    earners: read('mon.fcEarners'),
    lifeEvents: read('mon.fcEvents'),
    kidAges: read('mon.fcKidAges'),
    accountContributions: read('mon.fcAccountContribs'),
    projectionSummary: read('mon.fcSummary'),
  };
  // The summary is only recomputed while the Forecast page is open. If an input
  // was changed from a chat card since then, say so, so the assistant doesn't
  // quote a success probability that predates the change as current.
  const summary = forecast.projectionSummary as { computedAt?: string } | null;
  let changedAt = '';
  try { changedAt = localStorage.getItem(FORECAST_CHANGED_KEY) ?? ''; } catch { /* no hint */ }
  if (summary && changedAt && (!summary.computedAt || changedAt > summary.computedAt)) {
    forecast.projectionSummary = {
      ...summary,
      status: 'OUT OF DATE: a forecast input was changed after this summary was computed. It refreshes when the Forecast tab is opened.',
    };
  }
  // Only send if the user has actually set up a forecast.
  return forecast.assumptions || forecast.projectionSummary ? forecast : undefined;
}

// Starter questions tailored to whichever section the user is currently viewing.
const SUGGESTIONS: Record<AssistantView, string[]> = {
  dashboard: [
    "What's my net worth?",
    'How has it changed this year?',
    'What are my largest accounts?',
    'How much home equity do I have?',
  ],
  allocation: [
    'What is my investment allocation?',
    "What's my largest holding?",
    'How exposed am I to tech stocks?',
    'How diversified is my portfolio?',
  ],
  budget: [
    "How's my spending this month?",
    'Which categories am I over budget on?',
    'How does this month compare to last?',
    'What was my biggest expense?',
  ],
  forecast: [
    'Am I on track to retire?',
    "What's my projected net worth at retirement?",
    'How would buying a home change my plan?',
    'What would improve my success probability?',
  ],
  report: [
    'What drove the change in my net worth this quarter?',
    'Does anything in my spending look miscategorized?',
    'Is anything in this report likely to be a data error?',
    'How is my account mix taxed, in general terms?',
  ],
};

// Parse a Server-Sent Events stream, invoking `onEvent` for each complete
// `event:`/`data:` pair as it arrives.
async function readSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, data);
    }
  }
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  );
}

// One chat bubble. An assistant answer may carry charts as fenced ```chart
// blocks; splitMessage turns the valid ones into specs and leaves everything
// else — including a block still streaming in, or one that fails validation —
// as the text it arrived as. Text is always rendered as React text nodes.
// Memoised so typing in the composer doesn't re-parse and redraw every chart.
const MessageBubble = memo(function MessageBubble({ message, index, pending, large, onActionState }: {
  message: Message; index: number; pending: boolean; large: boolean;
  onActionState: (messageIndex: number, actionIndex: number, next: ActionState | undefined) => void;
}) {
  const isUser = message.role === 'user';
  const parts = useMemo(
    () => (isUser ? [] : splitMessage(message.content)),
    [isUser, message.content],
  );
  // A chart or a change card needs the bubble's full width.
  const hasChart = parts.some(p => p.kind !== 'text');
  return (
    <div
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        // A chart needs the room; text-only bubbles keep the chat-style inset.
        maxWidth: hasChart ? '100%' : '85%',
        width: hasChart ? '100%' : undefined,
        background: isUser ? 'var(--accent)' : 'var(--bg)',
        color: isUser ? 'var(--on-accent)' : 'var(--text)',
        border: isUser ? 'none' : '1px solid var(--border)',
        borderRadius: 12, padding: '9px 12px',
        fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}
    >
      {isUser
        ? message.content
        : parts.length
          ? parts.map((p, i) => (
              p.kind === 'chart' ? <AssistantChart key={i} spec={p.spec} tall={large} />
              : p.kind === 'action' ? (
                <AssistantActionCard
                  key={i} action={p.action} state={message.actions?.[p.index]}
                  onState={next => onActionState(index, p.index, next)}
                />
              )
              : <div key={i}>{p.text}</div>))
          : (message.content || (pending ? <span style={{ color: 'var(--muted)' }}>Thinking…</span> : ''))}
    </div>
  );
});

export default function AiAssistant({ view }: { view: AssistantView }) {
  const suggestions = SUGGESTIONS[view] ?? SUGGESTIONS.dashboard;
  const [open, setOpen] = useState(() => readSession(OPEN_KEY) === '1');
  const [messages, setMessages] = usePersistentState<Message[]>('kevfin.assistant.messages', []);
  const [input, setInput] = useState(() => readSession(DRAFT_KEY));
  useEffect(() => { writeSession(OPEN_KEY, open ? '1' : ''); }, [open]);
  useEffect(() => { writeSession(DRAFT_KEY, input); }, [input]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [large, setLarge] = useState(readLarge); // the panel's larger size (remembered per browser)
  const isMobile = useIsMobile();
  // The report view frames the report page, which has its own "Save as PDF"
  // button in the same bottom-right corner; sit above it there.
  const lift = view === 'report' ? 68 : 0;
  const [dragging, setDragging] = useState(false); // a file is being dragged over the panel
  const [importNote, setImportNote] = useState<string | null>(null); // transient "importing…" note
  const scrollRef = useRef<HTMLDivElement>(null);

  // Check Claude login when the panel opens, so we present a login prompt before
  // the user can chat rather than letting the first message fail.
  const { status: auth, command: authCommand, recheck } = useClaudeAuth(open);
  const authReady = auth === 'ok';

  // Hand a dropped document off to the importer (mounted in TopNav), which runs
  // the read → review → confirm flow. Keeps one import code path for both surfaces.
  function importDroppedFile(file: File) {
    setDragging(false);
    setImportNote(`Importing “${file.name}” — review the proposed entries in the dialog.`);
    window.dispatchEvent(new CustomEvent(IMPORT_FILE_EVENT, { detail: { file } }));
    window.setTimeout(() => setImportNote(null), 6000);
  }

  // Record what the user did with one proposed change (applied / dismissed /
  // undone). Stable identity, so the memoised bubbles don't all re-render.
  const onActionState = useCallback((messageIndex: number, actionIndex: number, next: ActionState | undefined) => {
    setMessages(prev => prev.map((m, i) => {
      if (i !== messageIndex) return m;
      const actions = { ...(m.actions ?? {}) };
      if (next) actions[actionIndex] = next; else delete actions[actionIndex];
      return { ...m, actions };
    }));
  }, [setMessages]);

  // Keep the latest message in view as it streams in.
  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open, streaming, large]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming) return;
    setInput('');
    setError(null);

    const history = [...messages, { role: 'user' as const, content }];
    // Append the user turn plus an empty assistant turn we stream tokens into.
    setMessages([...history, { role: 'assistant', content: '' }]);
    setStreaming(true);

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `report` tells the server the quarterly report view is open, so the
        // assistant is given the stored report's text to answer from.
        body: JSON.stringify({ messages: toWire(history), clientContext: { forecast: readForecastContext(), report: view === 'report' } }),
      });
      if (!res.ok || !res.body) {
        const msg = await res.json().catch(() => null);
        throw new Error(msg?.error ?? `Request failed (HTTP ${res.status})`);
      }
      await readSSE(res.body, (event, data) => {
        if (event === 'delta') {
          const token = JSON.parse(data) as string;
          setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], role: 'assistant', content: next[next.length - 1].content + token };
            return next;
          });
        } else if (event === 'error') {
          const payload = JSON.parse(data) as { message?: string };
          throw new Error(payload.message ?? 'The assistant request failed.');
        }
      });
      reportLoggedIn(); // the request completed — we're authenticated
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      // A login failure: show the login gate (driven by this real outcome) rather
      // than a bare error in the thread.
      if (/logged in|\/login/i.test(msg)) { setError(null); reportLoggedOut(); }
      else setError(msg);
      // Drop the empty/partial assistant turn so the conversation stays clean.
      setMessages(prev => {
        const last = prev[prev.length - 1];
        return last && last.role === 'assistant' && !last.content ? prev.slice(0, -1) : prev;
      });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <>
      {/* Floating launcher */}
      <button
        onClick={() => { if (!open) void prefetchClaudeAuth(); setOpen(o => !o); }}
        title={open ? 'Close assistant' : 'Ask the AI assistant'}
        aria-label={open ? 'Close assistant' : 'Ask the AI assistant'}
        style={{
          position: 'fixed', bottom: 24 + lift, right: 24, zIndex: 1000,
          width: 56, height: 56, borderRadius: '50%', padding: 0,
          background: 'var(--accent)', color: 'var(--on-accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        }}
      >
        <span style={{ width: 24, height: 24, display: 'block' }}>
          {open ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          ) : <ChatIcon />}
        </span>
      </button>

      {open && (
        <div
          onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true); }}
          onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
          onDrop={e => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) importDroppedFile(file);
            else setDragging(false);
          }}
          style={{
            position: 'fixed', bottom: 92 + lift, zIndex: 1000,
            // Normal: a compact card above the launcher. Larger: about twice as wide
            // and as tall as the window allows (charts and long answers need the
            // room); on a phone, where the card is already nearly full width, it
            // grows to fill the screen above the launcher instead. Every size is
            // clamped to the viewport.
            ...(large
              ? (isMobile
                ? { right: 8, width: 'calc(100vw - 16px)', height: `calc(100vh - ${100 + lift}px)` }
                : { right: 24, width: 760, maxWidth: 'calc(100vw - 48px)', height: `calc(100vh - ${116 + lift}px)` })
              : { right: 24, width: 380, maxWidth: 'calc(100vw - 48px)', height: 560, maxHeight: `calc(100vh - ${140 + lift}px)` }),
            display: 'flex', flexDirection: 'column',
            background: 'var(--surface)', border: `1px solid ${dragging ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 16, boxShadow: '0 12px 40px rgba(0,0,0,0.45)', overflow: 'hidden',
          }}
        >
          {dragging && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 5, borderRadius: 16,
              background: 'var(--accent-dim)', border: '2px dashed var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
              color: 'var(--accent)', fontSize: 14, fontWeight: 600, padding: 24, pointerEvents: 'none',
            }}>
              Drop a statement or tax return to import it
            </div>
          )}
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px', borderBottom: '1px solid var(--border)',
          }}>
            <div>
              <p style={{ fontWeight: 600, fontSize: 15 }}>AI Assistant</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {messages.length > 0 && (
                <button
                  className="btn-ghost"
                  onClick={() => { setMessages([]); setError(null); }}
                  disabled={streaming}
                  style={{ fontSize: 11, padding: '4px 10px' }}
                >Clear</button>
              )}
              <button
                className="btn-ghost"
                onClick={() => setLarge(v => { writeLarge(!v); return !v; })}
                aria-pressed={large}
                aria-label={large ? 'Make the chat smaller' : 'Make the chat larger'}
                title={large ? 'Make the chat smaller' : 'Make the chat larger'}
                style={{ padding: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              ><SizeIcon large={large} /></button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Login gate — shown before any chat when Claude isn't logged in. */}
            {(auth === 'logged_out' || auth === 'no_binary') ? (
              <div style={{ margin: 'auto 0' }}>
                <ClaudeLoginPrompt command={authCommand} noBinary={auth === 'no_binary'} onRecheck={recheck} compact />
              </div>
            ) : (<>
            {messages.length === 0 && (
              <div style={{ margin: 'auto 0' }}>
                <p style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 8 }}>
                  {view === 'report'
                    ? 'Ask me about this report, or to fix something that looks wrong in it.'
                    : 'Ask me anything about your net worth, accounts, investments, or budget.'}
                </p>
                <p style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', marginBottom: 16, opacity: 0.8 }}>
                  Or drop a statement or tax return here to import it.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {suggestions.map(s => (
                    <button
                      key={s}
                      className="btn-ghost"
                      onClick={() => send(s)}
                      style={{ fontSize: 13, textAlign: 'left', padding: '8px 12px' }}
                    >{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              // On a phone the larger panel is taller, not much wider, so charts keep their compact size.
              <MessageBubble
                key={i} message={m} index={i} pending={streaming && i === messages.length - 1}
                large={large && !isMobile} onActionState={onActionState}
              />
            ))}
            {importNote && (
              <div style={{ fontSize: 12.5, color: 'var(--accent)', padding: '4px 2px' }}>📎 {importNote}</div>
            )}
            {error && (
              <div style={{ fontSize: 12.5, color: 'var(--red)', padding: '4px 2px' }}>{error}</div>
            )}
            </>)}
          </div>

          {/* Composer */}
          <form
            onSubmit={e => { e.preventDefault(); send(input); }}
            style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={authReady ? 'Ask a question…' : 'Log in to Claude to chat…'}
              disabled={streaming || !authReady}
              autoFocus
            />
            <button type="submit" className="btn-primary" disabled={streaming || !authReady || !input.trim()} style={{ padding: '8px 14px' }}>
              {streaming ? '…' : 'Send'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
