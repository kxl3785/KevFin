import { getDb } from '../db/schema.js';
import type { Category } from '../util/categorize.js';

// The single-field edits to manual assets and linked accounts, as one statement
// each. They are shared by the screens that make them (routes/assets.ts,
// routes/simplefin.ts) and by the AI assistant's apply-on-click actions
// (services/assistantActions.ts), so a change proposed in chat goes through
// exactly the write a click in the Dashboard would. Callers validate their input
// and re-snapshot net worth (takeSnapshot) afterwards — these only write.

export function setManualAssetValue(id: number | string, value: number): void {
  getDb().prepare(`UPDATE manual_assets SET value = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
}

export function setManualAssetCategory(id: number | string, category: Category): void {
  getDb().prepare(`UPDATE manual_assets SET category = ?, updated_at = datetime('now') WHERE id = ?`).run(category, id);
}

export function setAccountCategory(id: string, category: Category): void {
  getDb().prepare('UPDATE accounts SET category = ? WHERE id = ?').run(category, id);
}

// A hidden account drops out of the account list and the net-worth totals.
export function setAccountHidden(id: string, hidden: boolean): void {
  getDb().prepare('UPDATE accounts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
}
