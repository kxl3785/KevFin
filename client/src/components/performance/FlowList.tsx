import type { ReturnsFlow } from '@shared/apiTypes';
import { fmtMoney, fmtDate } from '../../lib/format.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { NOTE } from '../allocation/ui.tsx';

// The deposits and withdrawals found in each measured account's transactions.
// The returns card shows this panel from its "Money moved in and out" button.
// Each line has a switch: switched off, that line is treated as part of the
// investment result instead of money moved in or out.

export const FLOW_LIST_ID = 'returns-flow-list';

/** "Money moved in and out (3 counted of 4)" — the button text for this panel. */
export function flowButtonText(flows: ReturnsFlow[], isIncluded: (f: ReturnsFlow) => boolean): string {
  const counted = flows.filter(isIncluded).length;
  return `Money moved in and out (${counted} counted${flows.length !== counted ? ` of ${flows.length}` : ''})`;
}

export default function FlowList({ flows, isIncluded, onToggle, privacy }: {
  flows: ReturnsFlow[];
  isIncluded: (f: ReturnsFlow) => boolean;   // local (optimistic) state
  onToggle: (f: ReturnsFlow, include: boolean) => void;
  privacy: boolean;
}) {
  const isMobile = useIsMobile();
  const money = (n: number) => (privacy ? '••••••' : fmtMoney(n, { cents: true, sign: true }));

  return (
    <div id={FLOW_LIST_ID}>
      {flows.length === 0 ? (
        <p style={NOTE}>No deposits or withdrawals were found in the measured accounts for this period.</p>
      ) : (
        <>
          <p style={{ ...NOTE, marginBottom: 8 }}>
            Switch a line off if it was really earnings or an internal move rather than money you added or took out.
          </p>
          <ul style={{ listStyle: 'none', display: 'grid', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
            {flows.map(f => {
              const on = isIncluded(f);
              const kind = f.amount > 0 ? 'deposit' : 'withdrawal';
              return (
                <li key={f.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: isMobile ? 'wrap' : 'nowrap',
                  padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8,
                  background: 'var(--bg)', opacity: on ? 1 : 0.65,
                }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', width: 92, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{fmtDate(f.date)}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.description}>
                      {f.description || (f.amount > 0 ? 'Deposit' : 'Withdrawal')}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                      {f.accountName} · {kind}
                      {f.basis === 'guessed' && (
                        <span title="The description didn’t match a familiar deposit or withdrawal, so it’s counted to be safe."
                          style={{ marginLeft: 6, padding: '0 5px', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--amber)' }}>
                          guessed
                        </span>
                      )}
                    </span>
                  </span>
                  <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', flex: 'none', textAlign: 'right', minWidth: 96, textDecoration: on ? 'none' : 'line-through' }}>
                    {money(f.amount)}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`Count ${f.description || kind} on ${fmtDate(f.date)} as a ${kind}`}
                    onClick={() => onToggle(f, !on)}
                    style={{
                      flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 4px', minHeight: 32,
                      background: 'transparent', color: 'var(--muted)', fontSize: 12, fontWeight: 500,
                    }}
                  >
                    <span aria-hidden="true" style={{ minWidth: 72, textAlign: 'right' }}>{on ? 'Counted' : 'Not counted'}</span>
                    <span aria-hidden="true" style={{
                      width: 32, height: 18, borderRadius: 9, padding: 2, boxSizing: 'border-box',
                      background: on ? 'var(--accent)' : 'var(--border)', transition: 'background 0.15s',
                      display: 'inline-flex', justifyContent: on ? 'flex-end' : 'flex-start',
                    }}>
                      <span style={{ width: 14, height: 14, borderRadius: '50%', background: on ? 'var(--on-accent)' : 'var(--surface)', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
