// One observation by id, whichever layer holds it. `mem_get_observation` is the only reader:
// it needs the full untruncated row, not the viewer's view (no effective salience, no noise flag).
import type { Database as DB } from "better-sqlite3";

export type Observation =
  | { layer: "episode"; id: string; scope: string; text: string; created_at: number }
  | {
      layer: "memory";
      id: string;
      scope: string;
      gist: string;
      details: string | null;
      salience: number;
      created_at: number;
    }
  | {
      layer: "trait";
      id: string;
      scope: string;
      name: string;
      strength: number;
      polarity: string;
      created_at: number;
      updated_at: number;
    };

export function observationById(db: DB, id: string): Observation | null {
  const episode = db
    .prepare("SELECT id, scope, body AS text, created_at FROM episodes WHERE id = ?")
    .get(id) as Omit<Extract<Observation, { layer: "episode" }>, "layer"> | undefined;
  if (episode) return { layer: "episode", ...episode };

  const memory = db
    .prepare("SELECT id, scope, gist, details, salience, created_at FROM memories WHERE id = ?")
    .get(id) as Omit<Extract<Observation, { layer: "memory" }>, "layer"> | undefined;
  if (memory) return { layer: "memory", ...memory };

  const trait = db
    .prepare(
      "SELECT id, scope, name, strength, polarity, created_at, updated_at FROM traits WHERE id = ?",
    )
    .get(id) as Omit<Extract<Observation, { layer: "trait" }>, "layer"> | undefined;
  if (trait) return { layer: "trait", ...trait };

  return null;
}
