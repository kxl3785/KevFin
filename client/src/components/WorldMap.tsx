import { useState, useEffect } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import { isGeographic, resolveAtlasName, maxGeographicPct, shadeColor, MIN_SHADE_PCT, BASE_RGB, LOW_RGB, HIGH_RGB } from '../lib/countryExposure.ts';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

interface Slice { name: string; value: number; pct: number }

// Renders nothing; reports (via effect, not during render) which countries with
// exposure have no polygon in the atlas so the parent can list them.
function ReportUnplaced({ names, onReport }: { names: string[]; onReport: (n: string[]) => void }) {
  const key = names.join('|');
  useEffect(() => { onReport(key ? key.split('|') : []); }, [key, onReport]);
  return null;
}

const rgb = (c: number[]) => `rgb(${c.join(',')})`;
const pctLabel = (p: number) => (p >= 0.1 ? `${(p * 100).toFixed(0)}%` : `${(p * 100).toFixed(p < 0.01 ? 1 : 0)}%`);

export default function WorldMap({ data, money }: { data: Slice[]; money: (n: number) => string }) {
  const [tip, setTip] = useState<{ name: string; pct: number; value: number } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [unplaced, setUnplaced] = useState<string[]>([]);

  // Only real countries drive the colour scale: pseudo-buckets such as
  // "International / Other" have no geometry and would otherwise dwarf the max.
  const geo = data.filter(d => isGeographic(d.name) && d.pct > 0);
  const maxPct = maxGeographicPct(data);
  const top = geo.reduce<Slice | null>((b, d) => (!b || d.pct > b.pct ? d : b), null);

  return (
    <div>
      <div
        style={{ position: 'relative' }}
        onMouseMove={e => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
        }}
      >
        <ComposableMap projectionConfig={{ scale: 145 }} width={900} height={420} style={{ width: '100%', height: 'auto' }}>
          <Geographies geography={GEO_URL}>
            {({ geographies }: { geographies: { rsmKey: string; properties: { name: string } }[] }) => {
              // exposure keyed by the atlas's own country name
              const atlasNames = geographies.map(g => g.properties.name);
              const exposure = new Map<string, Slice>();
              const missing: string[] = [];
              for (const c of geo) {
                const n = resolveAtlasName(c.name, atlasNames);
                if (n) exposure.set(n, c); else missing.push(c.name);
              }
              return [<ReportUnplaced key="__unplaced" names={missing} onReport={setUnplaced} />, ...geographies.map(g => {
                const e = exposure.get(g.properties.name);
                return (
                  <Geography
                    key={g.rsmKey}
                    geography={g}
                    fill={e ? shadeColor(e.pct, maxPct) : rgb(BASE_RGB)}
                    stroke="#1a1d27"
                    strokeWidth={0.4}
                    onMouseEnter={() => setTip(e ? { name: e.name, pct: e.pct, value: e.value } : null)}
                    onMouseLeave={() => setTip(null)}
                    style={{
                      default: { outline: 'none' },
                      // Only countries with exposure react to hover.
                      hover: e ? { outline: 'none', fill: '#fbbf24' } : { outline: 'none' },
                      pressed: { outline: 'none' },
                    }}
                  />
                );
              })];
            }}
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
      {unplaced.length > 0 && (
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
          Not shown on map: {unplaced.map(n => `${n} ${((geo.find(d => d.name === n)?.pct ?? 0) * 100).toFixed(1)}%`).join(', ')}
        </p>
      )}
      {top && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          <span>{pctLabel(MIN_SHADE_PCT)}</span>
          <div style={{ flex: '0 1 160px', height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${rgb(LOW_RGB)}, ${rgb(HIGH_RGB)})` }} />
          <span>{pctLabel(top.pct)} ({top.name})</span>
          <span style={{ marginLeft: 'auto', textAlign: 'right' }}>log scale · % of invested portfolio · grey = none</span>
        </div>
      )}
    </div>
  );
}
