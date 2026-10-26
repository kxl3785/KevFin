import { useState, useMemo, useRef, useEffect } from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';
// Bundled (not fetched from a CDN) so the map works offline and loads nothing
// external. world-atlas 2.x (ISC) is Natural Earth data, which is public domain.
import atlas from 'world-atlas/countries-110m.json';
import { isGeographic, placeSlices, geoKey, maxGeographicPct, shadeColor, MIN_SHADE_PCT, BASE_RGB, LOW_RGB, HIGH_RGB, type AtlasGeo } from '../lib/countryExposure.ts';

interface Slice { name: string; value: number; pct: number; code?: string }

// The atlas's geometries (id = ISO 3166-1 numeric string, null for a few).
const ATLAS_GEOS: AtlasGeo[] = (atlas as unknown as {
  objects: { countries: { geometries: { id?: string | null; properties: { name: string } }[] } };
}).objects.countries.geometries.map(g => ({ id: g.id, name: g.properties.name }));

const VIEW_W = 900;
// Markers are sized in screen pixels, not SVG units: the map scales with its card,
// and a fixed SVG radius shrinks to an invisible, unhoverable dot in a narrow one.
const MARKER_PX = 4.5;

const rgb = (c: number[]) => `rgb(${c.join(',')})`;
const pctLabel = (p: number) => (p >= 0.1 ? `${(p * 100).toFixed(0)}%` : `${(p * 100).toFixed(p < 0.01 ? 1 : 0)}%`);

export default function WorldMap({ data, money }: { data: Slice[]; money: (n: number) => string }) {
  const [tip, setTip] = useState<{ name: string; pct: number; value: number } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(VIEW_W);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e.contentRect.width > 0) setBoxW(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const unit = VIEW_W / boxW; // SVG units per screen pixel

  // Only real countries drive the colour scale: pseudo-buckets such as
  // "International / Other" have no geometry and would otherwise dwarf the max.
  const geo = data.filter(d => isGeographic(d.name) && d.pct > 0);
  const maxPct = maxGeographicPct(data);
  const top = geo.reduce<Slice | null>((b, d) => (!b || d.pct > b.pct ? d : b), null);
  // Polygon matches (by ISO numeric id), circle markers for places the atlas
  // has no polygon for, and whatever is left over.
  const placement = useMemo(() => placeSlices(geo, ATLAS_GEOS), [data]);
  const unplaced = placement.unplaced;
  // Smallest first, so the biggest marker ends up on top where they overlap (Hong Kong / Macao).
  const markers = [...placement.markers].sort((a, b) => a.slice.pct - b.slice.pct);

  return (
    <div>
      <div
        ref={boxRef}
        style={{ position: 'relative' }}
        onMouseMove={e => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
        }}
      >
        <ComposableMap projectionConfig={{ scale: 145 }} width={VIEW_W} height={420} style={{ width: '100%', height: 'auto' }}>
          <Geographies geography={atlas}>
            {({ geographies }: { geographies: { rsmKey: string; id?: string | null; properties: { name: string } }[] }) =>
              geographies.map(g => {
                const e = placement.polygons.get(geoKey({ id: g.id, name: g.properties.name }));
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
              })
            }
          </Geographies>
          {markers.map(({ slice: e, coordinates }) => (
            <Marker key={e.code ?? e.name} coordinates={coordinates}>
              <circle
                className="map-marker"
                data-country={e.code ?? e.name}
                r={MARKER_PX * unit}
                fill={tip?.name === e.name ? '#fbbf24' : shadeColor(e.pct, maxPct)}
                stroke="#e6e9f2"
                strokeOpacity={0.8}
                strokeWidth={unit}
                style={{ cursor: 'default' }}
                onMouseEnter={() => setTip({ name: e.name, pct: e.pct, value: e.value })}
                onMouseLeave={() => setTip(null)}
              />
            </Marker>
          ))}
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
          Not shown on map: {unplaced.map(d => `${d.name} ${(d.pct * 100).toFixed(1)}%`).join(', ')}
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
