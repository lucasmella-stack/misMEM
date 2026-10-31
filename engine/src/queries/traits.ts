// The trait detail of the viewer: the trait and the memories that still back it.
import type { Database as DB } from "better-sqlite3";
import { parseIds } from "./relations.js";
import { memoryView, traitView, type MemoryView, type TraitView } from "./views.js";
import { MEMORY_COLUMNS, type MemoryRow, type TraitRow } from "../store/rows.js";

type EvidenceMemory = MemoryView | { id: string; missing: true };

export interface TraitDetail {
  trait: TraitView;
  evidence: EvidenceMemory[];
}

export function traitDetail(db: DB, id: string, at: number): TraitDetail | null {
  const row = db
    .prepare(
      "SELECT id, scope, name, strength, polarity, evidence_memory_ids, created_at, updated_at FROM traits WHERE id = ?",
    )
    .get(id) as TraitRow | undefined;
  if (!row) return null;
  const getMemory = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`);
  const evidence = parseIds(row.evidence_memory_ids).map((memoryId): EvidenceMemory => {
    const m = getMemory.get(memoryId) as MemoryRow | undefined;
    return m ? memoryView(m, at) : { id: memoryId, missing: true as const };
  });
  return { trait: traitView(row), evidence };
}
