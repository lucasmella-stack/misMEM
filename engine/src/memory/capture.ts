// Owns `capture`: the dedup by content hash inside a scope, and the insert.
import type { Database as DB } from "better-sqlite3";
import { ulid } from "ulid";
import { CaptureInput } from "../schema.js";
import { contentHash } from "../domain/hash.js";

export function capture(db: DB, raw: unknown): { id: string; deduped: boolean } {
  const input = CaptureInput.parse(raw);
  const hash = contentHash(input.body);

  // Same (scope, body) already stored → do not duplicate; re-ingesting is idempotent.
  const existing = db
    .prepare(
      "SELECT id FROM episodes WHERE scope = ? AND content_hash = ? LIMIT 1",
    )
    .get(input.scope, hash) as { id: string } | undefined;
  if (existing) return { id: existing.id, deduped: true };

  const id = ulid();
  db.prepare(
    "INSERT INTO episodes (id, scope, body, created_at, content_hash) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.scope, input.body, Date.now(), hash);
  return { id, deduped: false };
}
