import { useRef, useState } from 'react';
import type { ReturnsData, ReturnsFlow } from '@shared/apiTypes';
import { useApi } from '../../hooks/useApi.ts';
import { usePersistentState } from '../../hooks/usePersistentState.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { fmtMoney, fmtDate } from '../../lib/format.ts';
import IncomeChart from './IncomeChart.tsx';
import FlowList, { FLOW_LIST_ID, flowButtonText } from './FlowList.tsx';
import { fmtPct, headline, nextOverrides, afterFailedSave, maskPercents, isShortSpan, spanLabel, type FlowOverride, type Measure } from './returnsDisplay.ts';
import { CARD, CardHeader, DisclosureButton, FactRow, FOOTER, NOTE, SkeletonBar, SkeletonStyles, StatTile, SubHeading, tileGrid } from '../allocation/ui.tsx';

// Contribution-aware returns beside the Investment Performance chart: what the
// accounts returned with deposits and withdrawals taken out, what the owner's
// dollars returned, a benchmark over the same dates, and dividend + interest
// income. Read-only — it describes what happened and never suggests a trade.
// Numbers come from GET /api/performance/returns (services/investmentReturns.ts).

// Same key the server reads (FLOW_OVERRIDES_PREF), via the shared prefs store.
const OVERRIDES_KEY = 'mon.returnsFlowOverrides';
const RANGES: { days: number; label: string; name: string }[] = [
  { days: 90, label: '3M', name: 'Past 3 months' },
  { days: 365, label: '1Y', name: 'Past year' },
  { days: 1095, label: '3Y', name: 'Past 3 years' },
  { days: 1825, label: '5Y', name: 'Past 5 years' },
];

export default function ReturnsSummary({ privacy }: { privacy: boolean }) {
  const isMobile = useIsMobile();
  const [storedDays, setDays] = usePersistentState<number>('mon.returnsDays', 365);
  const days = RANGES.some(r => r.days === storedDays) ? storedDays : 365;
  const [overrides, setOverrides] = usePersistentState<Record<string, FlowOverride>>(OVERRIDES_KEY, {});
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const [saving, setSaving] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The change that failed to save, so "Retry" re-sends it (the switch itself
  // has been put back to match the figures).
  const [retry, setRetry] = useState<{ flow: ReturnsFlow; include: boolean } | null>(null);
  // Which of the card's three panels is open (one at a time keeps it short).
  const [panel, setPanel] = useState<'accounts' | 'flows' | 'notes' | null>(null);
  const togglePanel = (p: 'accounts' | 'flows' | 'notes') => setPanel(cur => (cur === p ? null : p));

  const { data, loading, error, refetch } = useApi<ReturnsData>(`/api/performance/returns?days=${days}`);

  const pct = (n: number | null | undefined) => (privacy ? '••••' : (fmtPct(n) ?? '—'));
  const money = (n: number) => (privacy ? '••••••' : fmtMoney(n));
  const tone = (n: number | null | undefined) =>
    privacy || n == null || !Number.isFinite(n) ? 'var(--text)' : n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text)';

  // Optimistic: the switch reflects the local choice immediately; the server
  // recomputes after the pref is saved. Saves are chained so two quick
  // toggles reach the server in order. A failed save puts the switch back
  // (unless a newer toggle has replaced it), so the switches never disagree
  // with the figures, and offers Retry.
  const isIncluded = (f: ReturnsFlow) => overrides[f.id] !== 'exclude';
  function toggleFlow(f: ReturnsFlow, include: boolean) {
    const prev = overridesRef.current;
    const next = nextOverrides(prev, f.id, include);
    overridesRef.current = next;
    setOverrides(next);
    setSaveError(null);
    setRetry(null);
    setSaving(n => n + 1);
    saveChain.current = saveChain.current
      .then(async () => {
        const r = await fetch(`/api/prefs/${encodeURIComponent(OVERRIDES_KEY)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: JSON.stringify(next) }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await refetch();
      })
      .catch(() => {
        const back = afterFailedSave(overridesRef.current, next, prev);
        if (back !== overridesRef.current) {
          overridesRef.current = back;
          setOverrides(back);
        }
        setSaveError('Couldn’t save that change, so it was undone.');
        setRetry({ flow: f, include });
      })
      .finally(() => setSaving(n => n - 1));
  }

  const total = data?.total ?? null;
  const tDays = total?.days ?? 0;
  const twr = headline(total?.timeWeighted, tDays);
  const mwr = headline(total?.moneyWeighted, tDays);
  const bench = data?.benchmark ?? null;
  const benchMeasure: Measure | null = bench ? { periodReturn: bench.periodReturn, annualized: bench.annualized } : null;
  const bh = headline(benchMeasure, tDays);
  const noHistory = 'Not enough recorded history yet';

  // History much shorter than the period picked: said once, under the period
  // buttons, and the tiles then drop the repeated "over N days".
  const short = total != null && isShortSpan(tDays, days);
  const spanText = spanLabel(tDays);
  const unit = (h: { value: number | null; label: string }) => (h.value == null ? '' : short && h.label === spanText ? '' : h.label);
  const pickedName = RANGES.find(r => r.days === days)?.name.toLowerCase() ?? 'period picked';

  const notes = data?.caveats ?? [];

  return (
    <section aria-labelledby="returns-summary-h" style={CARD}>
      <CardHeader
        title="Returns with your deposits taken out"
        titleId="returns-summary-h"
        tip={<>Worked out from each account’s recorded daily balances and transactions. It describes what happened; it doesn’t suggest any trade.</>}
        subtitle="How your accounts did with the money you added or took out set aside."
        controls={(
          <div className="seg" role="group" aria-label="Period">
            {RANGES.map(r => (
              <button key={r.days} type="button" className={'seg-btn' + (days === r.days ? ' active' : '')}
                aria-pressed={days === r.days} aria-label={`${r.label}, ${r.name.toLowerCase()}`} onClick={() => setDays(r.days)}
                style={{ minHeight: 30 }}>
                {r.label}
              </button>
            ))}
          </div>
        )}
      />

      {loading && (
        <div aria-busy="true" aria-label="Working out returns">
          <SkeletonStyles />
          <div style={tileGrid(isMobile)}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', height: 104 }}>
                <SkeletonBar width="60%" height={10} />
                <SkeletonBar width="45%" height={20} style={{ marginTop: 14 }} />
                <SkeletonBar width="70%" height={8} style={{ marginTop: 12 }} />
              </div>
            ))}
          </div>
          <SkeletonBar height={150} style={{ marginTop: 52 }} />
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>
          Couldn’t load returns: {error}{' '}
          <button type="button" className="btn-ghost btn-sm" onClick={() => refetch()}>Retry</button>
        </p>
      )}

      {data && !loading && (
        <>
          {short && total && (
            <p role="note" style={{ ...NOTE, color: 'var(--text)', borderLeft: '3px solid var(--amber)', paddingLeft: 10, marginBottom: 12 }}>
              Measured over {spanText.replace(/^over /, '')} ({fmtDate(total.measuredFrom)} – {fmtDate(total.measuredTo)}), not the full {pickedName}:
              {' '}that’s all the recorded history there is so far.
            </p>
          )}

          {/* Wide screens: figures on the left, monthly income on the right. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))', gap: '20px 28px', alignItems: 'start' }}>
            <div style={{ minWidth: 0 }}>
              <div style={tileGrid(isMobile)}>
                <StatTile
                  label="Your return, deposits removed"
                  tip={<>The <strong>time-weighted return</strong>: how the investments themselves did, with the size and timing of your deposits and withdrawals taken out. It’s the fair number to set beside a market index.</>}
                  value={total ? pct(twr.value) : '—'}
                  unit={total ? unit(twr) : ''}
                  color={tone(twr.value)}
                  sub={!total ? noHistory : twr.total != null ? <>{pct(twr.total)} in total</> : `${fmtDate(total.measuredFrom)} – ${fmtDate(total.measuredTo)}`}
                />
                <StatTile
                  label="Return on your dollars"
                  tip={<>The <strong>money-weighted return</strong> (XIRR, or internal rate of return): the single rate that turns every dollar you put in into what you took out plus what’s there now. Money added just before a rise lifts it; money added just before a fall lowers it.</>}
                  value={total ? pct(mwr.value) : '—'}
                  unit={total ? unit(mwr) : ''}
                  color={tone(mwr.value)}
                  sub={!total ? noHistory : mwr.value == null ? 'Can’t be worked out for this period' : mwr.total != null ? <>{pct(mwr.total)} in total</> : 'Same dates'}
                />
                <StatTile
                  label={bench ? `${bench.label}, same dates` : 'Market comparison'}
                  tip={<>The index fund’s <strong>total return</strong> with dividends reinvested, over exactly the dates measured here. A comparison only.</>}
                  value={bh.value != null ? pct(bh.value) : '—'}
                  unit={bh.value != null && total ? unit(bh) : ''}
                  color={tone(bh.value)}
                  sub={bench && bh.value != null
                    ? (bh.total != null ? <>{pct(bh.total)} in total</> : `${fmtDate(bench.from)} – ${fmtDate(bench.to)}`)
                    : 'Prices unavailable'}
                />
                <StatTile
                  label="Dividends and interest, past 12 months"
                  tip={<>Dividends, interest and <strong>capital-gain distributions</strong> (funds paying out their gains) found in your transactions from {fmtDate(data.income.from)} to {fmtDate(data.income.to)}. The next-12-months figure is simply the past 12 months repeated, not a forecast.</>}
                  value={money(data.income.total)}
                  sub={<>Next 12 months, if the same: {money(data.income.nextTwelveMonths)}</>}
                />
              </div>

              {/* Coverage + the dollars behind the percentages, as one muted row */}
              <FactRow style={{ marginTop: 10 }} items={[
                data.coverage.accountCount === 0 ? 'No investment accounts connected.' : (
                  <>
                    Covers {data.coverage.includedCount} of {data.coverage.accountCount} investment account{data.coverage.accountCount === 1 ? '' : 's'}
                    {data.coverage.share != null && <> ({privacy ? '••' : Math.round(data.coverage.share * 100)}% of the balance)</>}
                  </>
                ),
                total && !short ? <>Measured {fmtDate(total.measuredFrom)} – {fmtDate(total.measuredTo)}</> : null,
                total ? <>Added {money(total.deposits)}</> : null,
                total ? <>Taken out {money(total.withdrawals)}</> : null,
                total ? (
                  <>Investment gain{' '}
                    <span style={{ color: tone(total.gain), fontVariantNumeric: 'tabular-nums' }}>{privacy ? '••••••' : fmtMoney(total.gain, { sign: true })}</span>
                  </>
                ) : null,
              ]} />
            </div>

            {/* Monthly income */}
            <div style={{ minWidth: 0 }}>
              <SubHeading style={{ marginTop: 0 }}>Dividends and interest by month</SubHeading>
              {data.income.total === 0 && data.income.months.every(m => m.total === 0) ? (
                <p style={NOTE}>No dividends or interest found in the past 12 full months of transactions.</p>
              ) : (
                <>
                  <IncomeChart months={data.income.months} privacy={privacy} />
                  {data.income.byAccount.length > 0 && (
                    <FactRow style={{ marginTop: 4 }} items={data.income.byAccount.map(a => <>{a.name} {money(a.total)}</>)} />
                  )}
                </>
              )}
            </div>
          </div>

          {/* Details, one panel at a time */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 16 }}>
            {data.accounts.length > 0 && (
              <DisclosureButton open={panel === 'accounts'} onToggle={() => togglePanel('accounts')} controls="returns-by-account">
                By account
              </DisclosureButton>
            )}
            <DisclosureButton open={panel === 'flows'} onToggle={() => togglePanel('flows')} controls={FLOW_LIST_ID}>
              {flowButtonText(data.flows, isIncluded)}
            </DisclosureButton>
            {notes.length > 0 && (
              <DisclosureButton open={panel === 'notes'} onToggle={() => togglePanel('notes')} controls="returns-notes">
                Good to know ({notes.length} {notes.length === 1 ? 'note' : 'notes'})
              </DisclosureButton>
            )}
            {saving > 0 && <span role="status" style={{ fontSize: 12, color: 'var(--muted)' }}>Updating…</span>}
          </div>
          {saveError && (
            <p role="alert" style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>
              {saveError}{' '}
              {retry && (
                <button type="button" className="btn-ghost btn-sm" disabled={saving > 0}
                  onClick={() => toggleFlow(retry.flow, retry.include)}>
                  Retry
                </button>
              )}
            </p>
          )}

          {panel === 'accounts' && (
            <ul id="returns-by-account" style={{ listStyle: 'none', display: 'grid', gap: 4, marginTop: 10, maxWidth: 760 }}>
              {data.accounts.map(a => {
                const at = headline(a.timeWeighted, a.days);
                const am = headline(a.moneyWeighted, a.days);
                const measurable = at.value != null || am.value != null;
                return (
                  <li key={a.id} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', fontSize: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px 12px', flexWrap: 'wrap' }}>
                      <span style={{ minWidth: 0 }}>{a.name} <span style={{ color: 'var(--muted)', fontSize: 12 }}>{a.institution}</span></span>
                      {a.included && measurable ? (
                        <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                          Deposits removed <strong style={{ color: tone(at.value) }}>{pct(at.value)}</strong> {at.value != null && at.label}
                          {' · '}your dollars <strong style={{ color: tone(am.value) }}>{pct(am.value)}</strong> {am.value != null && am.label}
                        </span>
                      ) : a.included ? (
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Not enough data</span>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--amber)' }}>Left out</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {a.included
                        ? `Measured ${fmtDate(a.measuredFrom!)} – ${fmtDate(a.measuredTo!)}`
                        : a.reason}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {panel === 'flows' && (
            <div style={{ marginTop: 10, maxWidth: 760 }}>
              <FlowList flows={data.flows} isIncluded={isIncluded} onToggle={toggleFlow} privacy={privacy} />
            </div>
          )}
          {panel === 'notes' && (
            <ul id="returns-notes" style={{ ...NOTE, maxWidth: '80ch', paddingLeft: 18, display: 'grid', gap: 4, marginTop: 10 }}>
              {notes.map((c, i) => <li key={i}>{privacy ? maskPercents(c) : c}</li>)}
            </ul>
          )}

          <p style={FOOTER}>Estimates for planning, not advice.</p>
        </>
      )}
    </section>
  );
}
