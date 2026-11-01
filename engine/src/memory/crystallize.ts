// Owns `crystallize`: upsert a trait by (scope, name) and add the new evidence to its strength.
import type { Database as DB } from "better-sqlite3";
import { ulid } from "ulid";
import { CrystallizeInput } from "../schema.js";

export function crystallize(
  db: DB,
  raw: unknown,
): { trait_id: string; created: boolean; strength: number } {
  const input = CrystallizeInput.parse(raw);
  const ts = Date.now();
  const evidenceJson = JSON.stringify(input.evidence_memory_ids);

  const existing = db
    .prepare("SELECT id, strength FROM traits WHERE scope = ? AND name = ?")
    .get(input.scope, input.name) as
    | { id: string; strength: number }
    | undefined;

  if (existing) {
    const newStrength = existing.strength + input.evidence_memory_ids.length;
    db.prepare(
      `UPDATE traits
       SET strength = ?, evidence_memory_ids = ?, polarity = ?, updated_at = ?
       WHERE id = ?`,
    ).run(newStrength, evidenceJson, input.polarity, ts, existing.id);
    return { trait_id: existing.id, created: false, strength: newStrength };
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO traits (id, scope, name, evidence_memory_ids, strength, polarity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope,
    input.name,
    evidenceJson,
    input.evidence_memory_ids.length,
    input.polarity,
    ts,
    ts,
  );
  return {
    trait_id: id,
    created: true,
    strength: input.evidence_memory_ids.length,
  };
}
