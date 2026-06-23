import { useMemo, useRef, useState, useEffect } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import { useApi } from '../hooks/useApi.ts';
import { usePersistentState } from '../hooks/usePersistentState.ts';
import TopNav, { type View } from '../components/TopNav.tsx';

interface Snapshot { date: string; accounts_total: number; real_estate_total: number; net_worth: number }
interface BudgetLite { income: number; spending: number }

type EventType = 'oneTime' | 'recurring' | 'income' | 'retire';
interface LifeEvent { id: string; label: string; icon: string; type: EventType; age: number; amount: number; untilAge?: number }
interface Assumptions {
  currentAge: number; endAge: number;
  investReturn: number; volatility: number; realEstateGrowth: number;
  annualIncome: number; annualSpending: number;
}

const DEFAULT_EVENTS: LifeEvent[] = [
  { id: 'home', label: 'Buy a home', icon: '🏠', type: 'oneTime', age: 44, amount: 150000 },
  { id: 'kid', label: 'Have a kid', icon: '🍼', type: 'recurring', age: 42, amount: 18000, untilAge: 60 },
  { id: 'income', label: 'Income raise', icon: '📈', type: 'income', age: 50, amount: 40000 },
  { id: 'expense', label: 'New expense', icon: '💳', type: 'recurring', age: 55, amount: 12000 },
  { id: 'retire', label: 'Retire', icon: '🌅', type: 'retire', age: 65, amount: 0 },
];

const TABS = ['Net Worth', 'Cash Flow', 'Success %'] as const;
type Tab = typeof TABS[number];
const RUNS = 400;
const PLOT_LEFT = 60, PLOT_RIGHT = 16; // matches YAxis width 52 + left margin 8, right margin 16

function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pctile(sorted: number[], p: number) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }

export default function Forecast({ onNavigate, privacy, onTogglePrivacy }: {
  onNavigate: (v: View) => void; privacy: boolean; onTogglePrivacy: () => void;
}) {
  // Pull the full snapshot series (newest-first, like the dashboard) and read
  // the latest entry so "Current net worth" here matches the dashboard headline
  // exactly. A small `days` limit would hit the ASC LIMIT in getNetWorthHistory
  // and return the OLDEST snapshots instead of the most recent.
  const { data: hist } = useApi<Snapshot[]>('/api/net-worth/history?days=10000');
  const { data: budget } = useApi<BudgetLite>('/api/budget');
  const latest = hist?.[0];
  const baseAccounts = latest?.accounts_total ?? 0;
  const baseRE = latest?.real_estate_total ?? 0;
  const currentNW = baseAccounts + baseRE;

  const [tab, setTab] = usePersistentState<Tab>('mon.fcTab', 'Net Worth');
  const [a, setA] = usePersistentState<Assumptions>('mon.fcAssumptions', {
    currentAge: 40, endAge: 90, investReturn: 0.06, volatility: 0.15, realEstateGrowth: 0.03, annualIncome: 180000, annualSpending: 70000,
  });
  const [events, setEvents] = usePersistentState<LifeEvent[]>('mon.fcEvents', DEFAULT_EVENTS);
  const [seeded, setSeeded] = usePersistentState('mon.fcSeeded', false);

  useEffect(() => {
    if (budget && !seeded) {
      setSeeded(true);
      setA(prev => ({
        ...prev,
        annualIncome: budget.income > 0 ? Math.round(budget.income * 12) : prev.annualIncome,
        annualSpending: budget.spending > 0 ? Math.round(budget.spending * 12) : prev.annualSpending,
      }));
    }
  }, [budget, seeded, setA, setSeeded]);

  const money = (n: number) => (privacy ? '••••••' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString());
  const moneyM = (n: number) => (privacy ? '•••' : '$' + (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k'));

  // Monte Carlo: random annual investment returns; deterministic income/spending/real estate.
  const sim = useMemo(() => {
    const retireAge = events.find(e => e.type === 'retire')?.age ?? Infinity;
    const years = Math.max(1, a.endAge - a.currentAge + 1);
    const nw: number[][] = Array.from({ length: years }, () => []);
    const invv: number[][] = Array.from({ length: years }, () => []);
    let successCount = 0;
    for (let s = 0; s < RUNS; s++) {
      let inv = baseAccounts, re = baseRE, income = a.annualIncome, solvent = true;
      for (let i = 0; i < years; i++) {
        const age = a.currentAge + i;
        for (const e of events) {
          if (e.age === age && e.type === 'oneTime') inv -= e.amount;
          if (e.age === age && e.type === 'income') income += e.amount;
        }
        const retired = age >= retireAge;
        const recurring = events.filter(e => e.type === 'recurring' && age >= e.age && age <= (e.untilAge ?? a.endAge)).reduce((t, e) => t + e.amount, 0);
        const ret = a.investReturn + a.volatility * randn();
        inv = inv * (1 + ret) + ((retired ? 0 : income) - (a.annualSpending + recurring));
        re = re * (1 + a.realEstateGrowth);
        if (inv < 0) solvent = false;
        nw[i].push(inv + re); invv[i].push(inv);
      }
      if (solvent) successCount++;
    }
    // Deterministic income/spending track for the Cash Flow tab.
    let dIncome = a.annualIncome;
    const yearNow = new Date().getFullYear();
    const bands = nw.map((arr, i) => {
      const age = a.currentAge + i;
      for (const e of events) if (e.age === age && e.type === 'income') dIncome += e.amount;
      const retired = age >= retireAge;
      const recurring = events.filter(e => e.type === 'recurring' && age >= e.age && age <= (e.untilAge ?? a.endAge)).reduce((t, e) => t + e.amount, 0);
      const sNw = [...arr].sort((x, y) => x - y);
      const sInv = [...invv[i]].sort((x, y) => x - y);
      const p10 = pctile(sNw, 0.1), p90 = pctile(sNw, 0.9);
      const ip10 = pctile(sInv, 0.1), ip90 = pctile(sInv, 0.9);
      return {
        age, year: yearNow + i,
        p10, p50: pctile(sNw, 0.5), band: Math.max(0, p90 - p10),
        invP10: ip10, invP50: pctile(sInv, 0.5), invBand: Math.max(0, ip90 - ip10),
        income: Math.round(retired ? 0 : dIncome), spending: Math.round(a.annualSpending + recurring),
      };
    });
    return { bands, successPct: Math.round(successCount / RUNS * 100) };
  }, [a, events, baseAccounts, baseRE]);

  const futureNW = sim.bands.length ? sim.bands[sim.bands.length - 1].p50 : currentNW;
  const deltaPct = currentNW ? ((futureNW - currentNW) / currentNW) * 100 : 0;

  function updateEvent(id: string, patch: Partial<LifeEvent>) { setEvents(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e))); }
  function removeEvent(id: string) { setEvents(prev => prev.filter(e => e.id !== id)); }
  function addEvent() { setEvents(prev => [...prev, { id: 'e' + Date.now(), label: 'New event', icon: '⭐', type: 'oneTime', age: a.currentAge + 5, amount: 10000 }]); }

  // --- Draggable event markers over the chart ---
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(920);
  const dragId = useRef<string | null>(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const plotW = Math.max(1, w - PLOT_LEFT - PLOT_RIGHT);
  const ageToX = (age: number) => PLOT_LEFT + ((age - a.currentAge) / Math.max(1, a.endAge - a.currentAge)) * plotW;
  useEffect(() => {
    function move(e: PointerEvent) {
      if (!dragId.current || !wrapRef.current) return;
      const x = e.clientX - wrapRef.current.getBoundingClientRect().left;
      let age = Math.round(a.currentAge + ((x - PLOT_LEFT) / plotW) * (a.endAge - a.currentAge));
      age = Math.max(a.currentAge, Math.min(a.endAge, age));
      updateEvent(dragId.current, { age });
    }
    function up() { dragId.current = null; }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [a.currentAge, a.endAge, plotW]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
      <TopNav view="forecast" onNavigate={onNavigate} privacy={privacy} onTogglePrivacy={onTogglePrivacy} />
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.5px' }}>Forecast</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 4 }}>Monte Carlo projection ({RUNS} runs). Drag an event marker on the chart to move it.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TABS.map(t => <button key={t} onClick={() => setTab(t)} className={tab === t ? 'btn-primary' : 'btn-ghost'} style={{ fontSize: 13 }}>{t}</button>)}
      </div>

      <div style={{ display: 'flex', gap: 40, marginBottom: 16, flexWrap: 'wrap' }}>
        <div><p style={{ color: 'var(--muted)', fontSize: 13 }}>Current net worth</p><p style={{ fontSize: 26, fontWeight: 700 }}>{money(currentNW)}</p></div>
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Median at age {a.endAge}</p>
          <p style={{ fontSize: 26, fontWeight: 700 }}>{money(futureNW)}</p>
          <p style={{ fontSize: 13, fontWeight: 600, color: deltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(futureNW - currentNW)} ({deltaPct >= 0 ? '+' : ''}{Math.round(deltaPct)}%)</p>
        </div>
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Success probability</p>
          <p style={{ fontSize: 26, fontWeight: 700, color: sim.successPct >= 90 ? 'var(--green)' : sim.successPct >= 70 ? 'var(--amber)' : 'var(--red)' }}>{sim.successPct}%</p>
        </div>
      </div>

      {/* Chart with draggable markers */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <div style={{ width: '100%', height: 360, filter: privacy ? 'blur(7px)' : 'none' }}>
            <ResponsiveContainer>
              <ComposedChart data={sim.bands} margin={{ top: 34, right: PLOT_RIGHT, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="gBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6c8fff" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#6c8fff" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                <XAxis dataKey="age" tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: '#7b7f95', fontSize: 11 }} tickLine={false} axisLine={false} width={52} tickFormatter={moneyM} />
                <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 8 }}
                  labelFormatter={age => `Age ${age}`} formatter={(v: number, n) => [money(v), n]} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#7b7f95' }} />
                {events.map(e => <ReferenceLine key={e.id} x={e.age} stroke="#4a4d5a" strokeDasharray="2 4" />)}
                {tab === 'Net Worth' && <>
                  <Area dataKey="p10" stackId="nw" stroke="none" fill="transparent" name=" " legendType="none" />
                  <Area dataKey="band" stackId="nw" stroke="none" fill="url(#gBand)" name="10–90% range" />
                  <Line dataKey="p50" name="Median net worth" stroke="#6c8fff" strokeWidth={2.5} dot={false} />
                </>}
                {tab === 'Cash Flow' && <>
                  <Line dataKey="income" name="Income" stroke="#4ade80" strokeWidth={2} dot={false} />
                  <Line dataKey="spending" name="Spending" stroke="#f87171" strokeWidth={2} dot={false} />
                </>}
                {tab === 'Success %' && <>
                  <Area dataKey="invP10" stackId="iv" stroke="none" fill="transparent" name=" " legendType="none" />
                  <Area dataKey="invBand" stackId="iv" stroke="none" fill="url(#gBand)" name="10–90% range" />
                  <Line dataKey="invP50" name="Median investable assets" stroke="#fbbf24" strokeWidth={2.5} dot={false} />
                  <ReferenceLine y={0} stroke="#f87171" strokeWidth={1.5} />
                </>}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {/* Draggable event chips */}
          {events.map((e, i) => (
            <div key={e.id}
              onPointerDown={ev => { ev.preventDefault(); dragId.current = e.id; }}
              title={`${e.label} · age ${e.age} — drag to move`}
              style={{
                position: 'absolute', left: ageToX(e.age), top: 2 + (i % 3) * 24, transform: 'translateX(-50%)',
                display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '2px 8px',
                fontSize: 11, cursor: 'grab', userSelect: 'none', touchAction: 'none', zIndex: 10,
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}>
              <span>{e.icon}</span><span>{e.label}</span>
            </div>
          ))}
        </div>
        {tab === 'Success %' && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
            Success probability = share of {RUNS} simulated futures where your investable assets never hit $0 (returns sampled each year from {Math.round(a.investReturn * 100)}% ± {Math.round(a.volatility * 100)}% volatility). The shaded band is the 10–90% outcome range.
          </p>
        )}
      </div>

      {/* Summary */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>✦ Summary</p>
        <p style={{ fontSize: 14, lineHeight: 1.5 }}>{summarize(a, events, futureNW, currentNW, sim.successPct)}</p>
      </div>

      {/* Editors */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>Life events</h2>
            <button className="btn-ghost" style={{ fontSize: 12 }} onClick={addEvent}>+ Add event</button>
          </div>
          {[...events].sort((x, y) => x.age - y.age).map(e => (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '20px 1fr 60px 100px 24px', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{e.icon}</span>
              <input value={e.label} onChange={ev => updateEvent(e.id, { label: ev.target.value })} style={{ fontSize: 13, padding: '3px 6px' }} />
              <input type="number" value={e.age} onChange={ev => updateEvent(e.id, { age: parseInt(ev.target.value) || 0 })} title="Age" style={{ fontSize: 12, padding: '3px 4px', width: 56 }} />
              {e.type === 'retire'
                ? <span style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>income → 0</span>
                : <input type="number" value={e.amount} onChange={ev => updateEvent(e.id, { amount: parseFloat(ev.target.value) || 0 })} style={{ fontSize: 12, padding: '3px 4px', width: 96 }} />}
              <span onClick={() => removeEvent(e.id)} title="Remove" style={{ cursor: 'pointer', color: 'var(--red)', textAlign: 'center' }}>×</span>
            </div>
          ))}
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Today's dollars. Drag chips on the chart, or edit ages here.</p>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Assumptions</h2>
          {([
            ['Current age', 'currentAge', 1, 1],
            ['Plan to age', 'endAge', 1, 1],
            ['Annual income', 'annualIncome', 1000, 1],
            ['Annual spending', 'annualSpending', 1000, 1],
            ['Investment return %', 'investReturn', 0.5, 100],
            ['Return volatility %', 'volatility', 1, 100],
            ['Real estate growth %', 'realEstateGrowth', 0.5, 100],
          ] as [string, keyof Assumptions, number, number][]).map(([label, key, step, mul]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
              <input type="number" step={step} value={Math.round((a[key] as number) * mul * 100) / 100}
                onChange={ev => setA(prev => ({ ...prev, [key]: (parseFloat(ev.target.value) || 0) / mul }))}
                style={{ fontSize: 13, padding: '3px 6px', width: 110, textAlign: 'right' }} />
            </div>
          ))}
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Returns are real (after inflation). Volatility drives the Monte Carlo spread.</p>
        </div>
      </div>
    </div>
  );
}

function summarize(a: Assumptions, events: LifeEvent[], future: number, current: number, success: number): string {
  if (!current) return 'Connect accounts to see a projection.';
  const growth = Math.round((future - current) / 1e6 * 10) / 10;
  const retire = events.find(e => e.type === 'retire');
  const parts: string[] = [`Median path: ${'$' + Math.round(current).toLocaleString()} today → about $${(future / 1e6).toFixed(1)}M by age ${a.endAge} (+$${growth}M).`];
  if (retire) parts.push(`You retire at ${retire.age}, then draw down investments.`);
  parts.push(success >= 90
    ? `Across ${RUNS} simulations your plan succeeds ${success}% of the time — robust to market swings.`
    : `⚠️ Only ${success}% of simulations stay solvent — consider saving more, retiring later, or spending less.`);
  return parts.join(' ');
}
