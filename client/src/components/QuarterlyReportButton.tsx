import { useEffect, useState } from 'react';

interface Status {
  available: boolean;
  quarterLabel: string;
  windowEndsAt: string | null;
}

/**
 * Permanent dashboard call-to-action for the quarterly report. It always renders
 * so the report is reachable year-round; clicking opens the freshly generated
 * report (a self-contained HTML page) in a new tab. It still polls the
 * availability window — only to label the button with the most-recent quarter and
 * to add a subtle "ready" highlight (filled fill + dot) during the few days right
 * after a quarter closes, when a fresh statement has just become available.
 */
export default function QuarterlyReportButton() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/report/quarterly/status')
      .then(r => (r.ok ? r.json() : null))
      .then(s => { if (!cancelled) setStatus(s); })
      .catch(() => { /* silent — button still renders with a generic label */ });
    return () => { cancelled = true; };
  }, []);

  const ready = !!status?.available;
  const label = status?.quarterLabel ? `${status.quarterLabel} report` : 'Quarterly report';
  const daysLeft = ready && status?.windowEndsAt
    ? Math.max(1, Math.ceil((new Date(status.windowEndsAt).getTime() - Date.now()) / 86400_000))
    : null;
  const title = ready
    ? `Your ${status?.quarterLabel} report is fresh — the quarter just closed${daysLeft ? ` (highlighted for ${daysLeft} more day${daysLeft === 1 ? '' : 's'})` : ''}`
    : 'Open your latest quarterly net-worth report';

  return (
    <a
      href="/api/report/quarterly"
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '7px 13px', borderRadius: 8, textDecoration: 'none',
        fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
        color: 'var(--accent)',
        background: ready ? 'var(--accent-dim)' : 'transparent',
        border: '1px solid var(--accent)',
      }}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor"
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h5M8 17h8" />
      </svg>
      {label}
      {ready && (
        <span
          aria-hidden="true"
          title="A fresh report is available"
          style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }}
        />
      )}
    </a>
  );
}
