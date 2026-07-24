import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export function defaultDbPath(): string {
  return resolve(process.env.MISMEM_DB ?? `${homedir()}/.mismem/mem.db`);
}

export function openDefaultDb(): DB {
  const path = defaultDbPath();
  mkdirSync(dirname(path), { recursive: true });
  return openDb(path);
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS episodes (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  consolidated_into TEXT REFERENCES memories(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_scope ON episodes(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON episodes(consolidated_into);

CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL,
  gist                TEXT NOT NULL,
  details             TEXT,
  source_episode_ids  TEXT NOT NULL,
  salience            REAL NOT NULL DEFAULT 1.0,
  created_at          INTEGER NOT NULL,
  last_accessed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, salience);

CREATE TABLE IF NOT EXISTS traits (
  id                   TEXT PRIMARY KEY,
  scope                TEXT NOT NULL,
  name                 TEXT NOT NULL,
  evidence_memory_ids  TEXT NOT NULL,
  strength             INTEGER NOT NULL DEFAULT 1,
  polarity             TEXT NOT NULL DEFAULT 'neutral',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(scope, name)
);
CREATE INDEX IF NOT EXISTS idx_traits_scope ON traits(scope, strength);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  body, content='episodes', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  gist, details, content='memories', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS traits_fts USING fts5(
  name, content='traits', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, gist, details) VALUES (new.rowid, new.gist, COALESCE(new.details, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, gist, details) VALUES('delete', old.rowid, old.gist, COALESCE(old.details, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, gist, details) VALUES('delete', old.rowid, old.gist, COALESCE(old.details, ''));
  INSERT INTO memories_fts(rowid, gist, details) VALUES (new.rowid, new.gist, COALESCE(new.details, ''));
END;

CREATE TRIGGER IF NOT EXISTS traits_ai AFTER INSERT ON traits BEGIN
  INSERT INTO traits_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER IF NOT EXISTS traits_ad AFTER DELETE ON traits BEGIN
  INSERT INTO traits_fts(traits_fts, rowid, name) VALUES('delete', old.rowid, old.name);
END;
CREATE TRIGGER IF NOT EXISTS traits_au AFTER UPDATE ON traits BEGIN
  INSERT INTO traits_fts(traits_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO traits_fts(rowid, name) VALUES (new.rowid, new.name);
END;
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}
