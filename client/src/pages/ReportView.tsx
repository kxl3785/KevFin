import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { regenerateReport, useReportRegen } from '../lib/reportRegen.ts';
import { fmtDate } from '../lib/format.ts';

interface Status { generatedAt: string | null; quarterLabel: string }

/**
 * The quarterly report, inside the app.
 *
 * The report itself is still the self-contained, printable page the server
 * builds (/api/report/quarterly); this view frames it so the AI assistant —
 * which only exists in the app — is available beside it. While this page is
 * open the chat tells the server so, and the assistant is given the stored
 * report's text to answer from (see AiAssistant and routes/assistant.ts).
 *
 * The frame is sandboxed without allow-same-origin: the report needs its one
 * inline script (its own "Save as PDF" button calls window.print), but it has no
 * business calling this app's API, and an opaque origin means it cannot.
 */
export default function ReportView() {
  const regen = useReportRegen();
  const [status, setStatus] = useState<Status | null>(null);
  const [loaded, setLoaded] = useState(false);

  // The header's quarter label and "generated" date; refreshed after a rebuild.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/report/quarterly/status')
      .then(r => (r.ok ? r.json() : null))
      .then(s => { if (!cancelled && s) setStatus(s); })
      .catch(() => { /* the frame still loads; the header just stays generic */ });
    return () => { cancelled = true; };
  }, [regen.version, loaded]);

  // A rebuilt report means a fresh frame load.
  useEffect(() => { setLoaded(false); }, [regen.version]);

  const running = regen.status === 'running';
  const title = status?.quarterLabel ? `${status.quarterLabel} report` : 'Quarterly report';

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      }}>
        <Link to="/" className="btn-ghost btn-sm" style={{ textDecoration: 'none', display: 'inline-block', borderRadius: 7 }}>← Dashboard</Link>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600 }}>{title}</h1>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            {running
              ? 'Rebuilding with your latest data. This can take a minute or two.'
              : status?.generatedAt
                ? `Generated ${fmtDate(new Date(status.generatedAt))}. Ask the assistant about anything in it.`
                : 'Ask the assistant about anything in it.'}
          </p>
        </div>
        <button
          type="button" className="btn-ghost btn-sm" disabled={running}
          onClick={() => void regenerateReport()}
          title="Rebuild the report from your current data"
        >{running ? 'Rebuilding…' : 'Regenerate'}</button>
        <a
          href="/api/report/quarterly" target="_blank" rel="noopener noreferrer"
          className="btn-ghost btn-sm" style={{ textDecoration: 'none', display: 'inline-block', borderRadius: 7 }}
        >Open in new tab</a>
      </header>

      {regen.status === 'error' && (
        <p role="alert" style={{ padding: '8px 16px', fontSize: 13, color: 'var(--red)', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          The report could not be rebuilt: {regen.error} The copy below is the previous one.
        </p>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {!loaded && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 14,
          }}>
            Preparing your report. The first time each quarter this can take a minute or two.
          </div>
        )}
        <iframe
          key={regen.version}
          src="/api/report/quarterly"
          title={title}
          sandbox="allow-scripts allow-modals"
          onLoad={() => setLoaded(true)}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none',
            // The report is a light, paper-style page in every theme.
            background: loaded ? '#fff' : 'transparent', opacity: running ? 0.55 : 1,
          }}
        />
      </div>
    </div>
  );
}
