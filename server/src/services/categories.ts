import { getDb } from '../db/schema.js';
import {
  TAXONOMY, CATEGORIES, suggestEmoji,
  type CatDef, type CatGroup,
} from './taxonomy.js';

// Category management: the active category list (with display renames, emoji
// and group overrides), the labeler applied at output boundaries, and the
// snapshot/undo/reset operations behind the manage-categories UI. Extracted
// from budget.ts; budget re-exports everything here so consumers are unchanged.

export const CATEGORY_GROUP: Record<string, string> = Object.fromEntries(TAXONOMY.flatMap(g => g.categories.map(c => [c.name, g.name])));
export const GROUP_COLOR: Record<string, string> = Object.fromEntries(TAXONOMY.map(g => [g.name, g.color]));
export const TAX_EMOJI: Record<string, string> = Object.fromEntries(TAXONOMY.flatMap(g => g.categories.map(c => [c.name, c.emoji])));
// All group names in taxonomy order, plus a trailing "Custom" bucket for
// user-added categories. Drives both group ordering and the reclassify dropdown.
const GROUP_ORDER: string[] = [...TAXONOMY.map(g => g.name), 'Custom'];
export const groupColorOf = (g: string): string => GROUP_COLOR[g] ?? '#94a3b8';
// A category's default group: its taxonomy group, or "Custom" for user-added ones.
export const defaultGroupOf = (name: string): string => CATEGORY_GROUP[name] ?? 'Custom';

// Effective group for every active category: an explicit override (grp column),
// else the taxonomy/Custom default. Drives the manage UI and the cash-flow Sankey.
export function getCategoryGroupMap(): Record<string, string> {
  const rows = getDb().prepare('SELECT name, grp FROM budget_categories').all() as { name: string; grp: string | null }[];
  const m: Record<string, string> = {};
  for (const r of rows) m[r.name] = (r.grp && r.grp.trim()) ? r.grp.trim() : defaultGroupOf(r.name);
  return m;
}

// Picker taxonomy with display overrides applied + a trailing "Custom" group for
// user-added categories. Each category also carries `canonical` (its stable id)
// so the manage UI can target renames precisely.
export function getCategoryGroups(): (Omit<CatGroup, 'categories'> & { categories: (CatDef & { canonical: string; custom?: boolean })[] })[] {
  const lab = getCategoryLabeler();
  const taxNames = new Set(CATEGORIES);
  const groupOf = getCategoryGroupMap();
  // Build from the ACTIVE categories so removals stick and reclassifications are
  // reflected — not from the static taxonomy. Categories sort alphabetically
  // within their group; groups follow taxonomy order (custom groups last).
  const byGroup = new Map<string, (CatDef & { canonical: string; custom?: boolean })[]>();
  for (const c of getActiveCategories()) {
    const g = groupOf[c] ?? 'Custom';
    const arr = byGroup.get(g) ?? [];
    arr.push({ name: lab.label(c), emoji: lab.emoji(c) ?? TAX_EMOJI[c] ?? suggestEmoji(c), canonical: c, custom: !taxNames.has(c) });
    byGroup.set(g, arr);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  const names = [...byGroup.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  return names.map(g => ({ name: g, color: groupColorOf(g), categories: byGroup.get(g)! }));
}

// The full ordered list of group names, for the manage UI's reclassify dropdown
// (so a category can be moved even into a group that's currently empty).
export function getGroupNames(): string[] { return [...GROUP_ORDER]; }


const PROTECTED = new Set(['Paychecks', 'Other Income', 'Dividends & Capital Gains', 'Transfers', 'Credit Card Payment', 'Mortgage', 'Miscellaneous']); // can't be removed

// Display overrides (rename + emoji) keyed by canonical category name. Applied at
// output boundaries; inputs are canonicalised back before touching stored data.
export interface CategoryLabeler { label: (c: string) => string; canon: (l: string) => string; emoji: (c: string) => string | undefined }
export function getCategoryLabeler(): CategoryLabeler {
  const rows = getDb().prepare('SELECT name, label, emoji FROM budget_categories').all() as { name: string; label: string | null; emoji: string | null }[];
  const toLabel = new Map<string, string>(), toCanon = new Map<string, string>(), emojiMap = new Map<string, string>();
  for (const r of rows) {
    const lbl = r.label && r.label.trim() ? r.label.trim() : r.name;
    if (lbl !== r.name) { toLabel.set(r.name, lbl); toCanon.set(lbl, r.name); }
    if (r.emoji) emojiMap.set(r.name, r.emoji);
  }
  return {
    label: c => toLabel.get(c) ?? c,
    canon: l => toCanon.get(l) ?? l,
    emoji: c => emojiMap.get(c),
  };
}

export function getActiveCategories(): string[] {
  return (getDb().prepare('SELECT name FROM budget_categories ORDER BY sort, name').all() as { name: string }[]).map(r => r.name);
}

// Add a new (custom) category, auto-picking an emoji from its name. Returns the
// created category name (or the existing canonical if the name collides).
export function addCategory(name: string, emoji?: string): string {
  const clean = name.trim().slice(0, 30);
  if (!clean) return '';
  const db = getDb();
  // If the name matches an existing canonical or its label, reuse that one.
  const lab = getCategoryLabeler();
  const canon = lab.canon(clean);
  if (getActiveCategories().includes(canon)) return canon;
  const max = (db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM budget_categories').get() as { m: number }).m;
  db.prepare('INSERT OR IGNORE INTO budget_categories (name, sort, emoji) VALUES (?, ?, ?)').run(clean, max + 1, emoji || suggestEmoji(clean));
  return clean;
}

// Rename (display label) and/or re-emoji a category. `name` is the canonical id.
export function renameCategory(name: string, label?: string, emoji?: string) {
  const db = getDb();
  if (!getActiveCategories().includes(name)) return;
  if (label !== undefined) {
    const clean = label.trim().slice(0, 30);
    // null out the override when the label is empty or equals the canonical name.
    db.prepare('UPDATE budget_categories SET label = ? WHERE name = ?').run(clean && clean !== name ? clean : null, name);
  }
  if (emoji !== undefined) db.prepare('UPDATE budget_categories SET emoji = ? WHERE name = ?').run(emoji || null, name);
}

// Reclassify a category into another group (affects the manage UI, the picker
// grouping and the cash-flow Sankey). Clears the override when it matches the
// taxonomy default.
export function setCategoryGroup(name: string, group: string) {
  const canon = getCategoryLabeler().canon(name);
  if (!getActiveCategories().includes(canon)) return;
  const g = group.trim();
  const val = g && g !== defaultGroupOf(canon) ? g : null;
  getDb().prepare('UPDATE budget_categories SET grp = ? WHERE name = ?').run(val, canon);
}

export function removeCategory(name: string) {
  const canon = getCategoryLabeler().canon(name);
  if (PROTECTED.has(canon)) return;
  const db = getDb();
  db.prepare('DELETE FROM budget_categories WHERE name = ?').run(canon);
  db.prepare('DELETE FROM budget_targets WHERE category = ?').run(canon);
  // Its merchant/base rules fall back to auto; smart rules for a removed
  // category are left in place (they resolve to Miscellaneous at read time),
  // matching the old per-table behavior.
  db.prepare(`DELETE FROM rules WHERE kind IN ('merchant', 'base') AND category = ?`).run(canon);
}

// --- Category management: snapshot / undo / reset ---------------------------
// A full snapshot of everything the manage-categories UI can touch (the category
// list with its renames/emojis, plus the targets and rules that reference them).
// Captured when the panel opens so "Undo changes" can restore it losslessly.
export interface CategoryState {
  categories: { name: string; sort: number; label: string | null; emoji: string | null; grp: string | null }[];
  targets: { category: string; monthly_limit: number; period: string }[];
  rules: { merchant: string; category: string }[];
  baseRules: { base: string; category: string }[];
  smartRules: { base: string | null; contains: string | null; amount: number | null; category: string }[];
}

export function getCategoryState(): CategoryState {
  const db = getDb();
  return {
    categories: db.prepare('SELECT name, sort, label, emoji, grp FROM budget_categories ORDER BY sort, name').all() as CategoryState['categories'],
    targets: db.prepare('SELECT category, monthly_limit, period FROM budget_targets').all() as CategoryState['targets'],
    rules: db.prepare(`SELECT merchant, category FROM rules WHERE kind = 'merchant'`).all() as CategoryState['rules'],
    baseRules: db.prepare(`SELECT base, category FROM rules WHERE kind = 'base'`).all() as CategoryState['baseRules'],
    smartRules: db.prepare(`SELECT base, contains, amount, category FROM rules WHERE kind = 'smart' ORDER BY id`).all() as CategoryState['smartRules'],
  };
}

// Replace the category list, targets and rules with a previously-captured snapshot.
export function restoreCategoryState(s: CategoryState) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM budget_categories').run();
    db.prepare('DELETE FROM budget_targets').run();
    // Sign-flip rules aren't part of the snapshot (they never were) — only the
    // category-bearing kinds are replaced.
    db.prepare(`DELETE FROM rules WHERE kind IN ('merchant', 'base', 'smart')`).run();
    const ic = db.prepare('INSERT INTO budget_categories (name, sort, label, emoji, grp) VALUES (?, ?, ?, ?, ?)');
    for (const c of s.categories ?? []) ic.run(c.name, c.sort ?? 0, c.label ?? null, c.emoji ?? null, c.grp ?? null);
    const it = db.prepare('INSERT OR REPLACE INTO budget_targets (category, monthly_limit, period) VALUES (?, ?, ?)');
    for (const t of s.targets ?? []) it.run(t.category, t.monthly_limit, t.period === 'annual' ? 'annual' : 'monthly');
    const ir = db.prepare(`INSERT OR REPLACE INTO rules (kind, merchant, category) VALUES ('merchant', ?, ?)`);
    for (const r of s.rules ?? []) ir.run(r.merchant, r.category);
    const ib = db.prepare(`INSERT OR REPLACE INTO rules (kind, base, category) VALUES ('base', ?, ?)`);
    for (const r of s.baseRules ?? []) ib.run(r.base, r.category);
    const is = db.prepare(`INSERT INTO rules (kind, base, contains, amount, category) VALUES ('smart', ?, ?, ?, ?)`);
    for (const r of s.smartRules ?? []) is.run(r.base ?? null, r.contains ?? null, r.amount ?? null, r.category);
  })();
}

// Reset the taxonomy to defaults: the built-in category list with its default
// order, clearing all renames/emoji overrides and removing custom categories.
// Budgets and rules for surviving (default) categories are kept; those that
// pointed at removed categories are pruned.
export function resetCategoriesToDefault() {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM budget_categories').run();
    const ins = db.prepare('INSERT INTO budget_categories (name, sort) VALUES (?, ?)');
    CATEGORIES.forEach((c, i) => ins.run(c, i));
    db.prepare('DELETE FROM budget_targets WHERE category NOT IN (SELECT name FROM budget_categories)').run();
    // Sign rules carry no category and survive a taxonomy reset, as before.
    db.prepare('DELETE FROM rules WHERE category IS NOT NULL AND category NOT IN (SELECT name FROM budget_categories)').run();
  })();
}

