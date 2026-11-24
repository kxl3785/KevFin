import { useState } from 'react';

// Three spreadsheet (CSV) downloads of the user's own data: transactions (with an
// optional date range), holdings, and the daily net-worth history. The server
// builds each file (server/src/services/csvExport.ts); this just fetches it and
// hands it to the browser as a download, so a failure can be shown in plain words
// instead of saving an error page as a .csv.

type Kind = 'transactions' | 'holdings' | 'net-worth';

const ITEMS: { kind: Kind; title: string; detail: string }[] = [
  { kind: 'transactions', title: 'Transactions', detail: 'Date, merchant, amount, category and account for every transaction, plus a KevFin ID that lets KevFin recognise each row if you import the file again' },
  { kind: 'holdings', title: 'Holdings', detail: 'Each investment by account: shares, value, cost basis (left blank when only partly known) and asset class' },
  { kind: 'net-worth', title: 'Net worth history', detail: 'One line per day: accounts, real estate equity and net worth' },
];

// The server's Content-Disposition filename, else one dated with today's local
// day (not the UTC day, which is already tomorrow on an American evening).
function filenameOf(res: Response, kind: Kind): string {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  if (m) return m[1];
  const d = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  return `kevfin-${kind}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}

export default function CsvExport() {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Kind | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  async function download(kind: Kind) {
    setError(null); setDone(null);
    if (kind === 'transactions' && from && to && from > to) {
      setError('The start date is after the end date.');
      return;
    }
    setBusy(kind);
    try {
      const qs = kind === 'transactions'
        ? new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()
        : '';
      const res = await fetch(`/api/export/${kind}.csv${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `The download didn’t work (error ${res.status}). Try again in a moment.`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameOf(res, kind);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(kind);
      setTimeout(() => setDone(d => (d === kind ? null : d)), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The download didn’t work.');
    } finally {
      setBusy(null);
    }
  }

  const dateInput: React.CSSProperties = { fontSize: 13, padding: '5px 7px', width: 'auto', minWidth: 0 };

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        Plain CSV files that open in Excel, Numbers or Google Sheets. They’re made on this computer and saved straight to your downloads.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ITEMS.map(item => (
          <div key={item.kind} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.title}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{item.detail}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {done === item.kind && <span role="status" style={{ fontSize: 12, color: 'var(--green)' }}>✓ Downloaded</span>}
                <button type="button" className="btn-ghost btn-sm" onClick={() => download(item.kind)}
                  disabled={busy !== null} aria-label={`Download ${item.title.toLowerCase()} as CSV`}>
                  {busy === item.kind ? 'Preparing…' : '↓ Download'}
                </button>
              </div>
            </div>
            {item.kind === 'transactions' && (
              <fieldset style={{ border: 'none', padding: 0, margin: '8px 0 0', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <legend style={{ fontSize: 12, color: 'var(--muted)', padding: 0, marginBottom: 4, float: 'left', width: '100%' }}>
                  Only these dates (optional)
                </legend>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  From
                  <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} style={dateInput} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                  To
                  <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} style={dateInput} />
                </label>
                {(from || to) && (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>
                )}
              </fieldset>
            )}
          </div>
        ))}
      </div>
      {error && <p role="alert" style={{ fontSize: 12.5, color: 'var(--red)', margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}
