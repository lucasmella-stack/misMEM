// The `meta` key/value table: counters and calibration values that do not deserve a column.
// Callers own the key name; nothing here interprets the value.
import type { Database as DB } from "better-sqlite3";

export function readMeta(db: DB, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function writeMeta(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
