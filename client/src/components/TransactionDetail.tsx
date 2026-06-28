import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import MerchantIcon from './MerchantIcon.tsx';

// Normalized shape any transaction row can hand to the detail popup. Only payee,
// amount and date are required; the rest render when present.
export interface TxnDetail {
  payee: string;
  merchant?: string;
  amount: number;
  category?: string;
  account?: string;
  date: string;                 // posted date, YYYY-MM-DD
  postedAt?: number;            // unix seconds (for time-of-day)
  transactedAt?: number | null; // unix seconds — when the purchase actually happened
  description?: string;         // raw bank descriptor (what auto-categorization matches on)
  memo?: string;
  suggested?: string;           // auto keyword guess for this row
  importedCategory?: string;    // original CSV category (Monarch etc.) for imported rows
}

// Module singleton so ANY transaction row can open the one shared popup without
// threading props/context through every list. The provider registers itself.
let _open: (t: TxnDetail) => void = () => {};
export function openTxnDetail(t: TxnDetail) { _open(t); }

const dayStr = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : '');
function fmtDate(iso: string) { return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtDateTime(unix: number) { return new Date(unix * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }

function DetailRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-word', fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : undefined }}>{value}</span>
    </div>
  );
}

/**
 * Renders ONE shared transaction-detail modal. Mount it once inside the area
 * whose rows should be clickable; rows call `openTxnDetail(txn)` to show it, so
 * the popup looks and behaves identically everywhere.
 */
export function TransactionDetailProvider({ children, privacy }: { children: ReactNode; privacy?: boolean }) {
  const [txn, setTxn] = useState<TxnDetail | null>(null);
  // Per-open status of the "mark as recurring" action.
  const [recurring, setRecurring] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const openTxn = (t: TxnDetail) => { setRecurring('idle'); setTxn(t); };
  useEffect(() => { _open = openTxn; return () => { if (_open === openTxn) _open = () => {}; }; }, []);
  const money = (n: number) => (privacy ? '••••••' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString());

  async function markRecurring() {
    if (!txn) return;
    setRecurring('saving');
    try {
      const res = await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payee: txn.payee, category: txn.category, amount: Math.abs(txn.amount) }),
      });
      setRecurring(res.ok ? 'done' : 'error');
    } catch { setRecurring('error'); }
  }

  const postedDay = txn ? (txn.postedAt ? dayStr(txn.postedAt) : txn.date) : '';
  const transDay = txn ? dayStr(txn.transactedAt) : '';
  const showTransacted = !!transDay && transDay !== postedDay;

  return (
    <>
      {children}
      {txn && createPortal(
        <div onClick={() => setTxn(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 440, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
            {/* Header: merchant, category, amount */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
              <MerchantIcon merchant={txn.merchant || txn.payee} label={txn.payee} size={40} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{txn.payee}</p>
                {txn.category && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{txn.category}</p>}
              </div>
              <p style={{ fontSize: 18, fontWeight: 700, color: txn.amount > 0 ? 'var(--green)' : 'var(--text)', flexShrink: 0 }}>{money(txn.amount)}</p>
            </div>
            {/* Detail rows — the extra data we normally hide per-row */}
            <div style={{ padding: '6px 20px 8px' }}>
              <DetailRow label="Account" value={txn.account} />
              <DetailRow label="Posted" value={txn.postedAt ? fmtDateTime(txn.postedAt) : fmtDate(txn.date)} />
              {showTransacted && <DetailRow label="Transacted" value={fmtDate(transDay)} />}
              <DetailRow label="Bank description" value={txn.description} mono />
              <DetailRow label="Memo" value={txn.memo} />
              {txn.merchant && txn.merchant.toLowerCase() !== txn.payee.toLowerCase() && (
                <DetailRow label="Merchant" value={txn.merchant} mono />
              )}
              {txn.importedCategory && txn.importedCategory !== txn.category && (
                <DetailRow label="Imported category" value={txn.importedCategory} />
              )}
              {txn.suggested && txn.suggested !== 'Miscellaneous' && txn.suggested !== txn.category && (
                <DetailRow label="Auto-suggested" value={`✨ ${txn.suggested}`} />
              )}
            </div>
            <div style={{ padding: '4px 20px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              {recurring === 'done' ? (
                <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ Added to Recurring</span>
              ) : (
                <button className="btn-ghost" style={{ fontSize: 13, padding: '6px 14px' }}
                  disabled={recurring === 'saving'}
                  title="Track this merchant on the Recurring page"
                  onClick={markRecurring}>
                  {recurring === 'saving' ? 'Adding…' : recurring === 'error' ? 'Retry — add failed' : '🔁 Mark as recurring'}
                </button>
              )}
              <button className="btn-ghost" style={{ fontSize: 13, padding: '6px 16px' }} onClick={() => setTxn(null)}>Close</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
