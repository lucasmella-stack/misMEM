// Reads an Engram SQLite database and writes its rows into misMEM as episodes. Idempotent: the
// id is a deterministic hash, so re-running skips duplicates. The source is opened read-only and
// closed before returning; the caller owns the target.
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { createHash } from "node:crypto";

export interface EngramSource {
  observations: Array<{
    id: number;
    type: string;
    title: string;
    content: string;
    tool_name: string | null;
    project: string | null;
    scope: string;
    topic_key: string | null;
    created_at: string;
  }>;
  sessions: Array<{
    id: string;
    project: string;
    directory: string;
    started_at: string;
    ended_at: string | null;
    summary: string | null;
  }>;
  prompts: Array<{ id: number; content: string; project: string | null; created_at: string }>;
}

export interface EngramMigration {
  inserted: number;
  skipped: number;
}

function epochMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function deterministicId(salt: string): string {
  // ULID is time-ordered + random; idempotence here needs a stable hash instead.
  const hash = createHash("sha256").update(salt).digest();
  // 26 hash bytes, one per character, each reduced mod 32 to index the alphabet.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i++) {
    const byte = hash[i % 32] ?? 0;
    out += alphabet[byte % 32];
  }
  return out;
}

function buildScope(prefix: string, project: string | null | undefined, suffix?: string): string {
  const p = (project ?? "global").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase() || "global";
  return suffix ? `${prefix}/${p}/${suffix}` : `${prefix}/${p}`;
}

/** Opens the Engram database read-only, reads the three tables and closes it. */
export function readEngramDb(file: string): EngramSource {
  const src = new Database(file, { readonly: true });
  try {
    const observations = src
      .prepare(
        `SELECT id, type, title, content, tool_name, project, scope, topic_key, created_at
         FROM observations WHERE deleted_at IS NULL`,
      )
      .all() as EngramSource["observations"];

    const sessions = src
      .prepare(
        `SELECT id, project, directory, started_at, ended_at, summary FROM sessions WHERE summary IS NOT NULL AND TRIM(summary) <> ''`,
      )
      .all() as EngramSource["sessions"];

    const prompts = src
      .prepare(`SELECT id, content, project, created_at FROM user_prompts`)
      .all() as EngramSource["prompts"];

    return { observations, sessions, prompts };
  } finally {
    src.close();
  }
}

/** Writes every row of `source` as an episode of `db`, in one transaction. */
export function migrateEngram(db: DB, source: EngramSource, scopePrefix: string): EngramMigration {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO episodes (id, scope, body, created_at) VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  let skipped = 0;
  const count = (changes: number): void => {
    if (changes > 0) inserted++;
    else skipped++;
  };

  db.transaction(() => {
    for (const o of source.observations) {
      const id = deterministicId(`engram-obs:${o.id}:${o.created_at}`);
      const scope = buildScope(scopePrefix, o.project);
      const topic = o.topic_key ? ` [${o.topic_key}]` : "";
      const tool = o.tool_name ? ` (tool:${o.tool_name})` : "";
      const body = `[${o.type}]${topic}${tool} ${o.title}\n\n${o.content}`;
      count(insert.run(id, scope, body, epochMs(o.created_at)).changes);
    }
    for (const s of source.sessions) {
      const id = deterministicId(`engram-sess:${s.id}`);
      const scope = buildScope(scopePrefix, s.project, "sessions");
      const body = `[session_summary] ${s.project} @ ${s.directory}\nStarted: ${s.started_at}${s.ended_at ? `\nEnded: ${s.ended_at}` : ""}\n\n${s.summary ?? ""}`;
      count(insert.run(id, scope, body, epochMs(s.started_at)).changes);
    }
    for (const p of source.prompts) {
      const id = deterministicId(`engram-prompt:${p.id}:${p.created_at}`);
      const scope = buildScope(scopePrefix, p.project, "prompts");
      const body = `[user_prompt] ${p.content}`;
      count(insert.run(id, scope, body, epochMs(p.created_at)).changes);
    }
  })();

  return { inserted, skipped };
}
