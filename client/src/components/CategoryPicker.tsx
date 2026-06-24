import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A searchable category picker: click the trigger chip to open a popover with a
// type-to-filter box, the auto-suggested category pinned on top, and categories
// grouped under intuitive headers with emoji. Full keyboard support (type to
// filter, ↑/↓ to move, Enter to pick, Esc to close). Replaces the native
// <select>, which was fiddly to scan in dense transaction tables.

// Category taxonomy supplied by the server (groups → subcategories with emoji).
// `canonical` is the stable id; `name` is the (possibly renamed) display label.
export interface PickerGroup { name: string; color?: string; categories: { name: string; emoji: string; canonical?: string; custom?: boolean }[] }

const CATCH_ALL = 'Miscellaneous';

function emojiMapFrom(groups?: PickerGroup[]): Record<string, string> {
  const m: Record<string, string> = {};
  if (groups) for (const g of groups) for (const c of g.categories) m[c.name] = c.emoji;
  return m;
}

// Build display groups in taxonomy order, filtered to the active options; any
// option not in the taxonomy (user-added) lands in a trailing "More" group.
function grouped(options: string[], excludeOther: boolean, groups?: PickerGroup[]): { label: string; items: string[] }[] {
  const pool = new Set(options.filter(c => !(excludeOther && c === CATCH_ALL)));
  const out: { label: string; items: string[] }[] = [];
  for (const g of groups ?? []) {
    const items = g.categories.map(c => c.name).filter(m => pool.has(m));
    items.forEach(m => pool.delete(m));
    if (items.length) out.push({ label: g.name, items });
  }
  if (pool.size) out.push({ label: 'More', items: [...pool] });
  return out;
}

function Row({ idx, emoji, label, hint, active, selected, onPick, onHover }: {
  idx: number; emoji: string; label: string; hint?: string;
  active: boolean; selected?: boolean; onPick: () => void; onHover: () => void;
}) {
  return (
    <div
      data-idx={idx}
      onClick={onPick}
      onMouseEnter={onHover}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        borderRadius: 6, cursor: 'pointer', fontSize: 13,
        background: active ? 'var(--accent-dim)' : 'transparent',
      }}
    >
      <span style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>{emoji}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {hint && <span style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>✨ {hint}</span>}
      {selected && !hint && <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>✓</span>}
    </div>
  );
}

export default function CategoryPicker({
  value, options, groups, suggested, onChange, onCreate, placeholder, excludeOther, triggerStyle, compact, zIndex = 1000,
}: {
  value: string;
  options: string[];
  groups?: PickerGroup[];
  suggested?: string;
  onChange: (cat: string) => void;
  onCreate?: (name: string) => void;
  placeholder?: string;
  excludeOther?: boolean;
  triggerStyle?: React.CSSProperties;
  compact?: boolean;
  zIndex?: number; // raise above an enclosing modal (the popover portals to body)
}) {
  const emoji = emojiMapFrom(groups);
  const catEmoji = (c: string) => emoji[c] ?? '🏷️';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const sections = grouped(options, !!excludeOther, groups)
    .map(g => ({ label: g.label, items: g.items.filter(c => c.toLowerCase().includes(q)) }))
    .filter(g => g.items.length);
  const showSuggested = !!suggested && suggested !== CATCH_ALL && options.includes(suggested) && suggested.toLowerCase().includes(q);
  const flat: string[] = [...(showSuggested ? [suggested!] : []), ...sections.flatMap(g => g.items)];
  // Offer to create a new category when the typed name matches nothing existing.
  const trimmed = query.trim();
  const canCreate = !!onCreate && trimmed.length > 0 && !options.some(c => c.toLowerCase() === trimmed.toLowerCase());

  function place() {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 240);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const POP_H = 320;
    const top = window.innerHeight - r.bottom > POP_H ? r.bottom + 4 : Math.max(8, r.top - 4 - POP_H);
    setPos({ left, top, width });
  }

  function openMenu() { setQuery(''); setHi(0); place(); setOpen(true); }
  function close() { setOpen(false); }
  function pick(cat: string) { onChange(cat); close(); }
  function create() { if (canCreate && onCreate) { onCreate(trimmed); close(); } }

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || triggerRef.current?.contains(e.target as Node)) return;
      close();
    };
    // Scrolling inside the popover's own list must NOT close it; for any other
    // scroll (the page or a parent container), re-anchor the fixed popover to
    // the trigger so it follows along instead of detaching.
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      place();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Keep the highlight in range and scrolled into view.
  useEffect(() => { setHi(h => Math.min(Math.max(0, h), Math.max(0, flat.length - 1))); }, [flat.length]);
  useEffect(() => {
    if (open) popRef.current?.querySelector(`[data-idx="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(flat.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[hi]) pick(flat[hi]); else if (canCreate) create(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  const isUnset = !value;
  let idx = 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        title={isUnset ? (placeholder ?? 'Categorize…') : value}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', width: '100%',
          background: 'var(--bg)', border: `1px solid ${isUnset ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6, color: isUnset ? 'var(--text)' : 'var(--muted)',
          fontSize: compact ? 11 : 12, padding: compact ? '3px 7px' : '4px 8px',
          ...triggerStyle,
        }}
      >
        {isUnset
          ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{placeholder ?? 'Categorize…'}</span>
          : <>
              <span style={{ flexShrink: 0 }}>{catEmoji(value)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
            </>}
        <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 9, flexShrink: 0 }}>▾</span>
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setHi(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search category…"
              style={{ width: '100%', padding: '6px 8px', fontSize: 13, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}
            />
          </div>
          <div style={{ maxHeight: 256, overflowY: 'auto', padding: 4 }}>
            {flat.length === 0 && !canCreate && <p style={{ padding: '10px 8px', fontSize: 12, color: 'var(--muted)' }}>No matching category</p>}
            {showSuggested && (
              <Row idx={idx++} emoji={catEmoji(suggested!)} label={suggested!} hint="suggested"
                active={hi === 0} onPick={() => pick(suggested!)} onHover={() => setHi(0)} />
            )}
            {sections.map(g => (
              <div key={g.label}>
                <p style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 8px 2px' }}>{g.label}</p>
                {g.items.map(c => {
                  const my = idx++;
                  return (
                    <Row key={c} idx={my} emoji={catEmoji(c)} label={c} selected={c === value}
                      active={hi === my} onPick={() => pick(c)} onHover={() => setHi(my)} />
                  );
                })}
              </div>
            ))}
            {canCreate && (
              <div onClick={create}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px', marginTop: flat.length ? 4 : 0, borderTop: flat.length ? '1px solid var(--border)' : 'none', cursor: 'pointer', fontSize: 13, color: 'var(--accent)' }}>
                <span style={{ width: 18, textAlign: 'center' }}>➕</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Create “{trimmed}”</span>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
