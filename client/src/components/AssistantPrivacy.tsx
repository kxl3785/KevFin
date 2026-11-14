import { useState } from 'react';

// What using the AI assistant shares, in the user's terms. KevFin keeps its data
// on the user's own machine; the assistant is the one feature that sends any of
// it elsewhere (to Anthropic, through the user's own Claude account), so the
// chat and its sign-in screen say so plainly instead of leaving it to the docs.
//
// Every line here is a statement about what the server actually does. If the
// behaviour changes, change these with it:
//   - what is sent / masked: server/src/services/assistant.ts (exportChatData,
//     buildFinancialContext) and server/src/util/privacyScrub.ts
//   - what it may do: SANDBOXED_CLAUDE_ARGS in services/assistant.ts, and the
//     Apply cards (services/assistantActions.ts)
//   - the off switch: isAssistantEnabled in server/src/services/data.ts, enforced
//     in routes/assistant.ts and services/report.ts
//   - the other two features that call Claude: services/ingest.ts (document
//     import) and services/report.ts (quarterly report commentary)

const GROUPS: { title: string; items: string[] }[] = [
  {
    title: 'Sent to Claude when you ask',
    items: [
      'Your question and this conversation',
      'A summary of your balances, holdings and budget',
      'The transactions or history it looks up to answer',
    ],
  },
  {
    title: 'Never sent',
    items: [
      'Bank logins, connection tokens and API keys',
      'Your street address (it sees the town only)',
      'Email addresses, phone numbers and long account numbers in transaction text, which are masked',
    ],
  },
  {
    title: 'Limits',
    items: [
      'It can read your data but not change it. A change it suggests waits for you to press Apply.',
      'It cannot browse the web, run commands or open other files.',
      'Claude is used only when you ask here, import a document (that document is sent) or build the quarterly report (summary figures only).',
      'What Anthropic keeps, and for how long, follows the privacy settings of your Claude account.',
      'This conversation is saved with your KevFin data. Clear deletes that copy.',
      'You can switch the assistant off in Setup. While it is off, nothing is sent to Claude.',
    ],
  },
];

export default function AssistantPrivacyNote({ align = 'center' }: { align?: 'center' | 'left' }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--muted)', textAlign: open ? 'left' : align }}>
      <p>
        Only this assistant uses Claude. The rest of KevFin runs on your own computer or server.
        Asking a question sends it, with the figures needed to answer, to Anthropic through your Claude account.{' '}
        <button
          type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ background: 'none', padding: 0, fontSize: 'inherit', fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', borderRadius: 0 }}
        >{open ? 'Hide details' : 'What is shared?'}</button>
      </p>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {GROUPS.map(g => (
            <div key={g.title}>
              <p style={{ fontWeight: 600, color: 'var(--text)' }}>{g.title}</p>
              <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                {g.items.map(i => <li key={i}>{i}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
