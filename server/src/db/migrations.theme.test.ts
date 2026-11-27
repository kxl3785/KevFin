import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from './migrations.js';

// Migration 8 moves anyone whose saved colour theme was the retired "Paper" to
// Ember, its replacement. Preferences are stored as the client's JSON strings.
const migrateTo = (db: Database.Database, version: number) => {
  for (const m of MIGRATIONS) {
    if (m.version > version) break;
    db.transaction(() => { m.up(db); db.pragma(`user_version = ${m.version}`); })();
  }
};
const theme = (db: Database.Database) =>
  (db.prepare("SELECT value FROM meta WHERE key = 'pref:mon.theme'").get() as { value: string } | undefined)?.value;

describe('paper-theme-to-ember migration', () => {
  it('rewrites a saved Paper theme to Ember', () => {
    const db = new Database(':memory:');
    migrateTo(db, 7);
    db.prepare("INSERT INTO meta (key, value) VALUES ('pref:mon.theme', '\"paper\"')").run();
    runMigrations(db);
    expect(theme(db)).toBe('"ember"');
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(8);
  });

  it('leaves every other saved theme, and other keys, alone', () => {
    for (const saved of ['"mist"', '"midnight"', '"slate"']) {
      const db = new Database(':memory:');
      migrateTo(db, 7);
      db.prepare("INSERT INTO meta (key, value) VALUES ('pref:mon.theme', ?)").run(saved);
      db.prepare("INSERT INTO meta (key, value) VALUES ('pref:mon.other', '\"paper\"')").run();
      runMigrations(db);
      expect(theme(db)).toBe(saved);
      expect((db.prepare("SELECT value FROM meta WHERE key = 'pref:mon.other'").get() as { value: string }).value).toBe('"paper"');
    }
  });

  it('is a no-op when no theme was ever saved', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(theme(db)).toBeUndefined();
  });
});
