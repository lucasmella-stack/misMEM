// The read model of a memory and a trait, shared by the list, the detail and the graph so the
// three name the same fields. Salience is the effective one (decayed to `at`), as in recall.
import { isNoiseGist } from "../domain/noise.js";
import { effectiveSalience } from "../memory/salience.js";
import type { MemoryRow, TraitRow } from "../store/rows.js";

export interface MemoryView {
  id: string;
  scope: string;
  text: string;
  details: string | null;
  salience: number;
  stored_salience: number;
  use_count: number;
  created_at: number;
  last_accessed_at: number | null;
  noise: boolean;
}

export interface TraitView {
  id: string;
  scope: string;
  text: string;
  strength: number;
  polarity: string;
  created_at: number;
  updated_at: number;
}

export function memoryView(row: MemoryRow, at: number): MemoryView {
  return {
    id: row.id,
    scope: row.scope,
    text: row.gist,
    details: row.details,
    salience: effectiveSalience(row, at),
    stored_salience: row.salience,
    use_count: row.use_count,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    noise: isNoiseGist(row.gist),
  };
}

export function traitView(row: TraitRow): TraitView {
  return {
    id: row.id,
    scope: row.scope,
    text: row.name,
    strength: row.strength,
    polarity: row.polarity,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
