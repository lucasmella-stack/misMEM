import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { seedTurnsFromUse } from "./connectome.js";
import { contentHash } from "../domain/hash.js";

export function defaultDbPath(): string {
  return resolve(process.env.MISMEM_DB ?? `${homedir()}/.mismem/mem.db`);
}

export function openDefaultDb(): DB {
  const path = defaultDbPath();
  // 0o700 only applies to directories created here; an existing one is left as it is.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
  consolidated_into TEXT REFERENCES memories(id) ON DELETE SET NULL,
  uncited_count     INTEGER NOT NULL DEFAULT 0
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
  salience_updated_at INTEGER,
  use_count           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, salience);

-- Índice hebbiano: qué recuerdos se usaron juntos en un mismo turno.
-- Sólo lo escribe el uso medido (reinforce), nunca la aparición en un recall.
CREATE TABLE IF NOT EXISTS co_use (
  memory_a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  n        INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (memory_a, memory_b),
  CHECK (memory_a < memory_b)
);
CREATE INDEX IF NOT EXISTS idx_co_use_b ON co_use(memory_b, n);

-- Contadores de la propia base. Hoy sólo vive acá el total de turnos de uso
-- medido, que es el denominador del índice hebbiano: sin él, el co-uso de un
-- recuerdo que se usa siempre no se distingue del azar.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
-- memories_au and traits_au are defined once, in migrate(): it must replace the legacy
-- versions that reindexed on every UPDATE, so a copy here would just be dropped right after.

CREATE TRIGGER IF NOT EXISTS traits_ai AFTER INSERT ON traits BEGIN
  INSERT INTO traits_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER IF NOT EXISTS traits_ad AFTER DELETE ON traits BEGIN
  INSERT INTO traits_fts(traits_fts, rowid, name) VALUES('delete', old.rowid, old.name);
END;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Traits and pending episodes have no id of their own to hang a foreign key from, so this
-- table keys on (layer, item_id) and the triggers below keep it in step with both sources.
-- Without it, recall would embed the whole layer pool on every query.
CREATE TABLE IF NOT EXISTS layer_embeddings (
  layer      TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (layer, item_id)
);

CREATE TRIGGER IF NOT EXISTS layer_embeddings_episode_ad AFTER DELETE ON episodes BEGIN
  DELETE FROM layer_embeddings WHERE layer = 'episode' AND item_id = old.id;
END;
-- A consolidated episode no longer competes in recall, so its vector is dead weight. If the
-- memory that absorbed it is later deleted, consolidated_into returns to NULL and the next
-- backfill re-embeds it.
CREATE TRIGGER IF NOT EXISTS layer_embeddings_episode_au
AFTER UPDATE OF consolidated_into ON episodes
WHEN new.consolidated_into IS NOT NULL BEGIN
  DELETE FROM layer_embeddings WHERE layer = 'episode' AND item_id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS layer_embeddings_trait_ad AFTER DELETE ON traits BEGIN
  DELETE FROM layer_embeddings WHERE layer = 'trait' AND item_id = old.id;
END;
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

  if (!cols.some((c) => c.name === "uncited_count")) {
    db.exec("ALTER TABLE episodes ADD COLUMN uncited_count INTEGER NOT NULL DEFAULT 0");
  }

  const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as Array<{
    name: string;
  }>;
  if (!memoryCols.some((c) => c.name === "salience_updated_at")) {
    db.exec("ALTER TABLE memories ADD COLUMN salience_updated_at INTEGER");
  }
  if (!memoryCols.some((c) => c.name === "use_count")) {
    db.exec("ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
  }

  // Legacy triggers reindexed FTS on any UPDATE, even when only salience,
  // timestamps or strength changed.
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

  // The turn counter is the denominator of counts that predate it: without this the
  // inherited pairs read as maximal associations. See `seedTurnsFromUse`.
  seedTurnsFromUse(db);
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.exec(SCHEMA);
  migrate(db);
  restrictToOwner(path);
  return db;
}

/**
 * The file holds the whole memory and is created with the default umask (usually 0644).
 * The WAL sidecars exist once the schema has switched the journal mode, hence this runs
 * after it. chmod is a no-op on Windows.
 */
const TOLERATED_CHMOD_ERRORS = new Set(["ENOENT", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"]);

function restrictToOwner(path: string): void {
  if (path === ":memory:" || path.startsWith("file:")) return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch (err) {
      // No existence check first (it would race with the file appearing or vanishing). The WAL
      // sidecars may not exist (ENOENT). A file owned by someone else, or on a shared volume or
      // NAS/SMB/FUSE mount that does not support chmod, can still be opened; failing to tighten
      // it must not stop a CLI that only wants to read it. Anything else is a real error.
      if (!TOLERATED_CHMOD_ERRORS.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
  }
}
