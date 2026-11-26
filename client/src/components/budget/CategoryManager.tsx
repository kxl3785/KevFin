import { useEffect, useState } from 'react';
import type { PickerGroup } from '../CategoryPicker.tsx';

const PROTECTED = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Credit Card Payment', 'Mortgage', 'Miscellaneous']);

// The category manager: rename a category, move it to another group, remove it,
// or add one; "Undo changes" rolls back everything done since this panel opened
// and "Reset to default" restores the built-in taxonomy. It used to open inside
// the Overview's Categories card; it now sits under "Categories & rules".
export default function CategoryManager({ groups, onChanged, toast, snapshot: catSnapshot, onSnapshot: setCatSnapshot }: {
  groups: PickerGroup[];
  onChanged: () => void;            // refetch the budget and bump dependants
  toast: (msg: string) => void;
  // The undo point, owned by the Budget page so it survives this panel being
  // closed and reopened (switching to Rules, or to another sub-tab and back).
  snapshot: unknown;
  onSnapshot: (s: unknown) => void;
}) {
  const [newCat, setNewCat] = useState('');
  // The snapshot is taken the FIRST time the panel opens on this visit to the
  // Budget tab, so "Undo changes" rolls back everything done since then.
  const [catBusy, setCatBusy] = useState(false);
  const [groupNames, setGroupNames] = useState<string[]>([]);
  // Group options for the reclassify dropdown (server list, or names in use).
  const groupOpts = groupNames.length ? groupNames : groups.map(g => g.name);

  useEffect(() => {
    let live = true;
    (async () => {
      if (catSnapshot == null) {
        try { const s = await (await fetch('/api/budget/categories/state')).json(); if (live) setCatSnapshot(s); }
        catch { /* no undo point; the button stays disabled */ }
      }
      try { const g = await (await fetch('/api/budget/categories/groups')).json(); if (live) setGroupNames(g); }
      catch { /* keep prior */ }
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addCat() {
    if (!newCat.trim()) return;
    await fetch('/api/budget/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCat.trim() }) });
    setNewCat(''); onChanged();
  }
  async function removeCat(name: string, label: string) {
    if (!confirm(`Remove the “${label}” category? Its transactions fall back to auto-categorization (you can re-add it any time).`)) return;
    await fetch(`/api/budget/category/${encodeURIComponent(name)}`, { method: 'DELETE' });
    onChanged();
  }
  // Rename a category's display label (canonical id stays stable everywhere).
  async function renameCat(canonical: string, label: string) {
    await fetch(`/api/budget/category/${encodeURIComponent(canonical)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
    onChanged();
  }
  // Reclassify a category into another group, or reorder it within its group.
  async function setCatGroup(canonical: string, group: string) {
    await fetch(`/api/budget/category/${encodeURIComponent(canonical)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group }) });
    onChanged();
  }
  // Roll back every category change made since the panel was opened.
  async function undoCats() {
    if (catSnapshot == null) return;
    setCatBusy(true);
    try {
      await fetch('/api/budget/categories/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(catSnapshot) });
      onChanged(); toast('↩ Reverted category changes');
    } finally { setCatBusy(false); }
  }
  // Reset the whole taxonomy to the built-in defaults (still undoable via the snapshot).
  async function resetCats() {
    if (!confirm('Reset all categories, names and emojis to defaults? Custom categories will be removed (their transactions fall back to auto-categorization).')) return;
    setCatBusy(true);
    try {
      await fetch('/api/budget/categories/reset', { method: 'POST' });
      onChanged(); toast('⟲ Categories reset to defaults');
    } finally { setCatBusy(false); }
  }

  return (
    <div className="db-card">
      <div className="db-head" style={{ marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h2>Categories</h2>
          <p className="db-sub" style={{ marginTop: 2 }}>Rename a category, move it to another group, or × to remove it. Changes apply everywhere.</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          <button className="btn-ghost btn-sm" disabled={catBusy || catSnapshot == null} onClick={undoCats}
            title="Revert every change made since you opened this page">↩ Undo changes</button>
          <button className="btn-ghost btn-sm" disabled={catBusy} onClick={resetCats}
            title="Restore the built-in categories, names and emojis">⟲ Reset to default</button>
        </div>
      </div>
      <div className="bud-mgr-groups">
        {groups.map(g => (
          <div key={g.name} style={{ marginBottom: 10, minWidth: 0 }}>
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color ?? 'var(--muted)', flexShrink: 0 }} />
              {g.name}
            </p>
            <div style={{ paddingLeft: 14 }}>
              {g.categories.map(c => {
                const canon = c.canonical ?? c.name;
                return (
                  <div key={canon} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 0' }}>
                    <span style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>{c.emoji}</span>
                    <input key={`${canon}:${c.name}`} defaultValue={c.name} aria-label={`Rename ${c.name}`}
                      onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name && c.canonical) renameCat(c.canonical, v); }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      style={{ flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }} />
                    <select value={g.name} onChange={e => setCatGroup(canon, e.target.value)} title="Reclassify into another group" aria-label={`Group for ${c.name}`}
                      style={{ flexShrink: 0, maxWidth: 104, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', fontSize: 11, padding: '3px 4px', cursor: 'pointer' }}>
                      {(groupOpts.includes(g.name) ? groupOpts : [g.name, ...groupOpts]).map(gn => <option key={gn} value={gn}>{gn}</option>)}
                    </select>
                    {!PROTECTED.has(canon) ? (
                      <button type="button" onClick={() => removeCat(canon, c.name)} title="Remove category" aria-label={`Remove ${c.name}`}
                        style={{ background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--red)', fontWeight: 700, flexShrink: 0, width: 12 }}>×</button>
                    ) : <span style={{ width: 12, flexShrink: 0 }} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name" aria-label="New category name"
          onKeyDown={e => { if (e.key === 'Enter') addCat(); }} style={{ flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 13 }} />
        <button className="btn-primary" style={{ fontSize: 12 }} onClick={addCat}>+ Add</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Removing a category sends its transactions back to automatic categorization.</p>
    </div>
  );
}
