import { useState } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

// Map our country labels to the names used by the world-atlas dataset.
const NAME_FIX: Record<string, string> = {
  'United States': 'United States of America',
  'Czechia': 'Czechia',
  'South Korea': 'South Korea',
};

interface Slice { name: string; value: number; pct: number }

function lerp(a: number[], b: number[], t: number) {
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`;
}

export default function WorldMap({ data, money }: { data: Slice[]; money: (n: number) => string }) {
  const [tip, setTip] = useState<{ name: string; pct: number; value: number } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // exposure keyed by atlas country name
  const exposure = new Map<string, { pct: number; value: number }>();
  for (const c of data) exposure.set(NAME_FIX[c.name] ?? c.name, { pct: c.pct, value: c.value });
  const maxPct = Math.max(0.0001, ...[...exposure.values()].map(e => e.pct));

  const COLD = [32, 36, 46];     // #20242e (no exposure)
  const WARM = [108, 143, 255];  // var(--accent)

  return (
    <div
      style={{ position: 'relative' }}
      onMouseMove={e => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
    >
      <ComposableMap projectionConfig={{ scale: 145 }} width={900} height={420} style={{ width: '100%', height: 'auto' }}>
        <Geographies geography={GEO_URL}>
          {({ geographies }: { geographies: { rsmKey: string; properties: { name: string } }[] }) =>
            geographies.map(geo => {
              const e = exposure.get(geo.properties.name);
              const t = e ? Math.sqrt(e.pct / maxPct) : 0;
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={e ? lerp(COLD, WARM, t) : '#20242e'}
                  stroke="#1a1d27"
                  strokeWidth={0.3}
                  onMouseEnter={() => setTip(e ? { name: geo.properties.name, pct: e.pct, value: e.value } : null)}
                  onMouseLeave={() => setTip(null)}
                  style={{ default: { outline: 'none' }, hover: { outline: 'none', fill: '#fbbf24' }, pressed: { outline: 'none' } }}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>
      {tip && (
        <div style={{
          position: 'absolute', left: pos.x + 12, top: pos.y + 12, pointerEvents: 'none', zIndex: 30,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px',
          fontSize: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.45)', whiteSpace: 'nowrap',
        }}>
          <strong>{tip.name}</strong> · {(tip.pct * 100).toFixed(1)}% · {money(tip.value)}
        </div>
      )}
    </div>
  );
}
