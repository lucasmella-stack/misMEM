// What MCP `recall` hands a model: the search hits plus the columns only their tables know.
// Lives in queries/ because it reads them; the ranking stays the search's decision.
import type { Database as DB } from "better-sqlite3";
import type { RecallHit } from "../schema.js";

/**
 * Cap on the `text` of a hit, in code points: one episode can hold tens of thousands of
 * characters and push every other memory out of the model's context. `id` still leads to the
 * full copy. `mismem-used` measures on the cut text, which a rare gist over the cap accepts.
 */
export const MAX_TEXT_CHARS = 2000;

/** Cap on the `details` of a memory, in code points, for the same reason as `MAX_TEXT_CHARS`. */
export const MAX_DETAILS_CHARS = 1200;

/** What `recall` returns to a model: the search hit plus the columns only its table knows. */
export interface RecallHitView extends RecallHit {
  /**
   * `created_at` as YYYY-MM-DD in UTC: a model reads a date, not an epoch. Absent when
   * `created_at` is not a usable epoch (a restored or hand-edited row), so one bad row
   * cannot fail the whole recall.
   */
  date?: string;
  /** The distilled detail of a memory, absent when it holds nothing. */
  details?: string;
  /** A trait's polarity, absent when it is `neutral`: the absence is the neutral case. */
  polarity?: "shadow" | "light";
  /** Present when any string of the hit was cut to its cap. */
  truncated?: true;
}

/**
 * Cuts `text` to at most `max` code points, ellipsis included, so the advertised cap is the
 * real one. `Array.from` counts code points instead of UTF-16 units: a plain `slice` could
 * leave half a surrogate pair and turn an emoji into a replacement character.
 */
function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: `${points.slice(0, max - 1).join("")}…`, truncated: true };
}

/**
 * Reads one column for a whole batch of ids in a single query. The view resolves every hit
 * of a layer at once; one query per hit would be N round trips per recall page.
 */
function selectColumn(
  db: DB,
  table: "memories" | "traits",
  column: "details" | "polarity",
  ids: readonly string[],
): Map<string, string | null> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, ${column} AS value FROM ${table} WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; value: string | null }>;
  return new Map(rows.map((row) => [row.id, row.value]));
}

/**
 * Adds what the search rows do not carry (a readable date, a memory's details, a trait's
 * polarity) and the per-string caps. `salience`, `created_at` and the order pass through.
 */
export function recallForModel(db: DB, hits: readonly RecallHit[]): RecallHitView[] {
  const memoryIds = hits.filter((hit) => hit.layer === "memory").map((hit) => hit.id);
  const traitIds = hits.filter((hit) => hit.layer === "trait").map((hit) => hit.id);
  const detailsById = selectColumn(db, "memories", "details", memoryIds);
  const polarityById = selectColumn(db, "traits", "polarity", traitIds);

  return hits.map((hit) => {
    const text = truncate(hit.text, MAX_TEXT_CHARS);
    const rawDetails = hit.layer === "memory" ? detailsById.get(hit.id) : undefined;
    const details =
      typeof rawDetails === "string" && rawDetails !== ""
        ? truncate(rawDetails, MAX_DETAILS_CHARS)
        : undefined;
    const rawPolarity = hit.layer === "trait" ? polarityById.get(hit.id) : undefined;
    const polarity = rawPolarity === "shadow" || rawPolarity === "light" ? rawPolarity : undefined;
    // A restored or hand-edited row can hold a non-finite or out-of-range epoch, and
    // toISOString throws on both; the hit is still useful without its date.
    const at = new Date(hit.created_at);
    const date = Number.isFinite(hit.created_at) && !Number.isNaN(at.getTime())
      ? at.toISOString().slice(0, 10)
      : undefined;

    const view: RecallHitView = {
      layer: hit.layer,
      id: hit.id,
      scope: hit.scope,
      text: text.text,
      ...(hit.salience === undefined ? {} : { salience: hit.salience }),
      created_at: hit.created_at,
      ...(date === undefined ? {} : { date }),
      ...(hit.via === undefined ? {} : { via: hit.via }),
      ...(details === undefined ? {} : { details: details.text }),
      ...(polarity === undefined ? {} : { polarity }),
    };
    return text.truncated || details?.truncated ? { ...view, truncated: true } : view;
  });
}
