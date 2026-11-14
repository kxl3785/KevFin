import { memo, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AssistantAction } from '@shared/assistantAction';
import { DATA_CHANGED_EVENT } from './Setup.tsx';
import { regenerateReport, useReportRegen } from '../lib/reportRegen.ts';
import { previewForecastChange, readForecastPlan, saveForecastChange } from '../lib/forecastEdit.ts';

// A change the AI assistant proposed, as a card the user can apply or dismiss.
//
// The assistant cannot change anything itself. What it wrote has already passed
// the shape check (lib/assistantChart.ts only hands over valid actions); this
// card then asks the SERVER what the action would do against the live data, and
// shows that — the server's wording and its before/after values, not the
// model's. The model's own one-line reason appears only as a quote.
//
// One kind of action is checked and applied here in the browser instead: a
// change to a Forecast input. The Forecast plan is browser state with no server
// table behind it, so it goes through lib/forecastEdit.ts — the same saved plan
// the Forecast page edits — with the same rule: the card shows the plan's own
// current value, not the model's claim about it.
//
// Nothing is applied without a click on Apply, and each click applies exactly
// this one action. Everything from the model or the server is rendered as text.

export interface ActionState { status: 'applied' | 'dismissed'; done?: string }

interface Preview { title: string; before: string; after: string; detail?: string; noop: boolean }

type Check =
  | { phase: 'checking' }
  | { phase: 'ready'; preview: Preview }
  | { phase: 'invalid'; error: string };

async function post<T>(url: string, action: AssistantAction): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}

const card: React.CSSProperties = {
  whiteSpace: 'normal', margin: '8px 0', padding: '10px 12px',
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
};
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--muted)' };
const small: React.CSSProperties = { fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 };

function AssistantActionCard({ action, state, onState }: {
  action: AssistantAction;
  state?: ActionState;
  onState: (next: ActionState | undefined) => void;
}) {
  const [check, setCheck] = useState<Check>({ phase: 'checking' });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const regen = useReportRegen();
  const [regenAsked, setRegenAsked] = useState(false);
  const navigate = useNavigate();
  const onForecastPage = useLocation().pathname.startsWith('/forecast');
  const isForecast = action.type === 'set_forecast_assumption';

  const settled = state?.status === 'applied' || state?.status === 'dismissed';

  // Ask the server what this would do. Skipped once applied or dismissed (the
  // card then only reports that), and re-run if a dismissal is undone.
  useEffect(() => {
    if (settled) return;
    if (action.type === 'set_forecast_assumption') {
      const r = previewForecastChange(action, readForecastPlan());
      setCheck(r.ok ? { phase: 'ready', preview: r.preview } : { phase: 'invalid', error: r.error });
      return;
    }
    let cancelled = false;
    setCheck({ phase: 'checking' });
    post<{ preview: Preview }>('/api/assistant/action/preview', action)
      .then(r => { if (!cancelled) setCheck({ phase: 'ready', preview: r.preview }); })
      .catch((e: unknown) => { if (!cancelled) setCheck({ phase: 'invalid', error: e instanceof Error ? e.message : 'This change could not be checked.' }); });
    return () => { cancelled = true; };
  }, [action, settled]);

  async function apply() {
    setApplying(true);
    setApplyError(null);
    try {
      if (action.type === 'set_forecast_assumption') {
        // Saved through the Forecast page's own persisted inputs, which also
        // notifies an open Forecast page; no server data changed.
        onState({ status: 'applied', done: saveForecastChange(action).done });
        return;
      }
      const r = await post<{ done: string; changed: boolean }>('/api/assistant/action/apply', action);
      onState({ status: 'applied', done: r.done });
      // Every page's data may have moved — have the mounted queries refetch.
      if (r.changed) window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'The change could not be applied.');
    } finally {
      setApplying(false);
    }
  }

  if (state?.status === 'applied') {
    const rebuilding = regenAsked && regen.status === 'running';
    const rebuilt = regenAsked && regen.status === 'idle';
    return (
      <div style={{ ...card, borderColor: 'var(--green)' }} role="status">
        <p style={{ ...label, color: 'var(--green)' }}>✓ Applied</p>
        <p style={{ fontSize: 13, marginTop: 3 }}>{state.done ?? 'The change was applied.'}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {isForecast
            // A forecast change needs no report rebuild; the projection is re-run
            // by the Forecast page, so offer the way there when it isn't open.
            ? onForecastPage
              ? <span style={small}>The projection on this page has been re-run with it.</span>
              : (
                <>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => navigate('/forecast')}>Open Forecast</button>
                  <span style={small}>The projection is re-run when the Forecast tab is open.</span>
                </>
              )
          : rebuilt
            ? <span style={small}>The quarterly report was rebuilt with this change.</span>
            : (
              <>
                <button
                  type="button" className="btn-ghost btn-sm" disabled={regen.status === 'running'}
                  onClick={() => { setRegenAsked(true); void regenerateReport(); }}
                >{rebuilding ? 'Rebuilding report…' : 'Regenerate report'}</button>
                <span style={small}>
                  {rebuilding
                    ? 'This can take a minute or two.'
                    : regenAsked && regen.status === 'error'
                      ? `The report could not be rebuilt: ${regen.error}`
                      : 'The quarterly report is a saved copy; rebuild it to include this change.'}
                </span>
              </>
            )}
        </div>
      </div>
    );
  }

  if (state?.status === 'dismissed') {
    return (
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={small}>Suggestion dismissed. Nothing was changed.</span>
        <button
          type="button" onClick={() => onState(undefined)}
          style={{ marginLeft: 'auto', background: 'transparent', padding: '2px 4px', fontSize: 12, color: 'var(--accent)' }}
        >Undo</button>
      </div>
    );
  }

  if (check.phase === 'checking') {
    return <div style={card}><span style={small}>Checking this suggestion against your data…</span></div>;
  }

  if (check.phase === 'invalid') {
    // Well-formed, but it does not match the data (no such transaction, a
    // category that doesn't exist…). Say so; there is nothing to apply.
    return (
      <div style={card} role="note">
        <p style={label}>Suggestion can’t be applied</p>
        <p style={{ fontSize: 13, marginTop: 3 }}>{check.error}</p>
        <p style={{ ...small, marginTop: 4 }}>Nothing was changed.</p>
      </div>
    );
  }

  const { preview } = check;
  return (
    <div style={card} role="group" aria-label={`Suggested change: ${preview.title}`}>
      <p style={label}>Suggested change</p>
      <p style={{ fontSize: 13.5, fontWeight: 600, marginTop: 3, lineHeight: 1.35 }}>{preview.title}</p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', margin: '8px 0 0', fontSize: 13 }}>
        <dt style={{ color: 'var(--muted)' }}>Now</dt>
        <dd style={{ margin: 0 }}>{preview.before}</dd>
        <dt style={{ color: 'var(--muted)' }}>After</dt>
        <dd style={{ margin: 0, fontWeight: 600 }}>{preview.after}</dd>
      </dl>
      {preview.detail && <p style={{ ...small, marginTop: 6 }}>{preview.detail}</p>}
      {action.reason && <p style={{ ...small, marginTop: 6 }}>Assistant’s reason: “{action.reason}”</p>}
      {applyError && <p role="alert" style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 6 }}>{applyError}</p>}
      {preview.noop ? (
        <p style={{ ...small, marginTop: 8 }}>This is already how your data is set, so there is nothing to apply.</p>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn-primary btn-sm" onClick={apply} disabled={applying}>
            {applying ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => onState({ status: 'dismissed' })} disabled={applying}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(AssistantActionCard);
