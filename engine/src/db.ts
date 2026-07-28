import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

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
  last_accessed_at    INTEGER,
  salience_updated_at INTEGER
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
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF gist, details ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, gist, details) VALUES('delete', old.rowid, old.gist, COALESCE(old.details, ''));
  INSERT INTO memories_fts(rowid, gist, details) VALUES (new.rowid, new.gist, COALESCE(new.details, ''));
END;

CREATE TRIGGER IF NOT EXISTS traits_ai AFTER INSERT ON traits BEGIN
  INSERT INTO traits_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER IF NOT EXISTS traits_ad AFTER DELETE ON traits BEGIN
  INSERT INTO traits_fts(traits_fts, rowid, name) VALUES('delete', old.rowid, old.name);
END;
CREATE TRIGGER IF NOT EXISTS traits_au AFTER UPDATE OF name ON traits BEGIN
  INSERT INTO traits_fts(traits_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO traits_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Additive migrations over DBs created before the column/index existed.
// Safe to re-run: each step checks current state first.
function migrate(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(episodes)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "content_hash")) {
    db.exec("ALTER TABLE episodes ADD COLUMN content_hash TEXT");
  }

  const pending = db
    .prepare("SELECT id, body FROM episodes WHERE content_hash IS NULL LIMIT 10000")
    .all() as Array<{ id: string; body: string }>;
  if (pending.length > 0) {
    const upd = db.prepare("UPDATE episodes SET content_hash = ? WHERE id = ?");
    const backfill = db.transaction((rows: Array<{ id: string; body: string }>) => {
      for (const r of rows) upd.run(contentHash(r.body), r.id);
    });
    // Chunked so a huge legacy DB never holds one giant transaction.
    let rows = pending;
    while (rows.length > 0) {
      backfill(rows);
      rows = db
        .prepare("SELECT id, body FROM episodes WHERE content_hash IS NULL LIMIT 10000")
        .all() as Array<{ id: string; body: string }>;
    }
  }

  // Non-unique on purpose: legacy DBs may already hold duplicates.
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_hash ON episodes(scope, content_hash)");

  const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as Array<{
    name: string;
  }>;
  if (!memoryCols.some((c) => c.name === "salience_updated_at")) {
    db.exec("ALTER TABLE memories ADD COLUMN salience_updated_at INTEGER");
  }

  // Legacy triggers reindexaban FTS ante cualquier UPDATE, incluso cuando
  // solo cambiaban salience, timestamps o strength.
  db.exec(`
    DROP TRIGGER IF EXISTS memories_au;
    CREATE TRIGGER memories_au AFTER UPDATE OF gist, details ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, gist, details)
      VALUES('delete', old.rowid, old.gist, COALESCE(old.details, ''));
      INSERT INTO memories_fts(rowid, gist, details)
      VALUES (new.rowid, new.gist, COALESCE(new.details, ''));
    END;

    DROP TRIGGER IF EXISTS traits_au;
    CREATE TRIGGER traits_au AFTER UPDATE OF name ON traits BEGIN
      INSERT INTO traits_fts(traits_fts, rowid, name)
      VALUES('delete', old.rowid, old.name);
      INSERT INTO traits_fts(rowid, name) VALUES (new.rowid, new.name);
    END;
  `);

  db.exec(
    `UPDATE memories
     SET salience_updated_at = COALESCE(last_accessed_at, created_at)
     WHERE salience_updated_at IS NULL`,
  );
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
