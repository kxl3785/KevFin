import { useState, useRef, useEffect } from 'react';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import { type View } from './TopNav.tsx';

interface Message { role: 'user' | 'assistant'; content: string }

// Starter questions tailored to whichever section the user is currently viewing.
const SUGGESTIONS: Record<View, string[]> = {
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

export default function AiAssistant({ view }: { view: View }) {
  const suggestions = SUGGESTIONS[view] ?? SUGGESTIONS.dashboard;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = usePersistentState<Message[]>('kevfin.assistant.messages', []);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as it streams in.
  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, open, streaming]);

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
        body: JSON.stringify({ messages: history }),
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
            next[next.length - 1] = { role: 'assistant', content: next[next.length - 1].content + token };
            return next;
          });
        } else if (event === 'error') {
          const payload = JSON.parse(data) as { message?: string };
          throw new Error(payload.message ?? 'The assistant request failed.');
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.';
      setError(msg);
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
        onClick={() => setOpen(o => !o)}
        title={open ? 'Close assistant' : 'Ask the AI assistant'}
        aria-label={open ? 'Close assistant' : 'Ask the AI assistant'}
        style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
          width: 56, height: 56, borderRadius: '50%', padding: 0,
          background: 'var(--accent)', color: '#fff',
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
          style={{
            position: 'fixed', bottom: 92, right: 24, zIndex: 1000,
            width: 380, maxWidth: 'calc(100vw - 48px)', height: 560, maxHeight: 'calc(100vh - 140px)',
            display: 'flex', flexDirection: 'column',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 16, boxShadow: '0 12px 40px rgba(0,0,0,0.45)', overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px', borderBottom: '1px solid var(--border)',
          }}>
            <div>
              <p style={{ fontWeight: 600, fontSize: 15 }}>AI Assistant</p>
              <p style={{ fontSize: 11, color: 'var(--muted)' }}>Ask about your finances</p>
            </div>
            {messages.length > 0 && (
              <button
                className="btn-ghost"
                onClick={() => { setMessages([]); setError(null); }}
                disabled={streaming}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >Clear</button>
            )}
          </div>

          {/* Messages */}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.length === 0 && (
              <div style={{ margin: 'auto 0' }}>
                <p style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 16 }}>
                  Ask me anything about your net worth, accounts, investments, or budget.
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
              <div
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background: m.role === 'user' ? 'var(--accent)' : 'var(--bg)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                  borderRadius: 12, padding: '9px 12px',
                  fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {m.content || (streaming && i === messages.length - 1
                  ? <span style={{ color: 'var(--muted)' }}>Thinking…</span>
                  : '')}
              </div>
            ))}
            {error && (
              <div style={{ fontSize: 12.5, color: 'var(--red)', padding: '4px 2px' }}>{error}</div>
            )}
          </div>

          {/* Composer */}
          <form
            onSubmit={e => { e.preventDefault(); send(input); }}
            style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask a question…"
              disabled={streaming}
              autoFocus
            />
            <button type="submit" className="btn-primary" disabled={streaming || !input.trim()} style={{ padding: '8px 14px' }}>
              {streaming ? '…' : 'Send'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
