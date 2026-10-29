import type { Database as DB } from "better-sqlite3";
import type { RecallHit } from "./schema.js";
import { excludeNoiseSql } from "./noise.js";

/**
 * Cap on the `text` of a hit, in code points. One episode can hold tens of thousands of
 * characters, and a single hit that size pushes every other memory out of the model's
 * context. The cut keeps enough to recognise the hit; `id` still leads to the full copy.
 *
 * `mismem-used` measures usage over the `text` the model saw, so a long gist (over 2000
 * code points, possible through `mem_update`) is measured on the cut text, which raises the
 * overlap for the same matches. It is rare enough to accept and keep the cap here.
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
 * Shapes the hits of `recall` for the model that reads them: a readable date, the details of
 * a memory and the polarity of a trait (columns the search rows do not carry), and
 * per-string caps. `salience` and `created_at` pass through untouched. Order is preserved:
 * the ranking is the search's decision.
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

/** Cap on the scopes listed by a recall with no hits: enough to spot a typo, not a catalogue. */
const MAX_SCOPES = 20;

/** What `recall` adds when it found nothing: which scopes do hold something. */
export interface RecallMissView {
  /** Scopes with memories, traits or pending episodes, most populated first. */
  scopes: string[];
  /** Present only when a scope was asked for: the miss belongs to that scope, not to the search. */
  hint?: string;
}

/**
 * A recall that found nothing is usually a scope written from memory, not an empty memory: a
 * misspelled scope and a scope nobody used look the same. The miss view lists the scopes that
 * do hold something so the model can retry instead of telling the user there is nothing.
 *
 * One query over the three layers, because this path already costs the model a turn. Noise
 * markers are excluded: they are bookkeeping for `forget`, not content.
 */
export function recallMissForModel(db: DB, scope?: string): RecallMissView {
  const rows = db
    .prepare(
      `SELECT scope, SUM(n) AS n FROM (
         SELECT scope, COUNT(*) AS n FROM memories m WHERE ${excludeNoiseSql("m")} GROUP BY scope
         UNION ALL
         SELECT scope, COUNT(*) AS n FROM traits GROUP BY scope
         UNION ALL
         SELECT scope, COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL GROUP BY scope
       ) GROUP BY scope ORDER BY n DESC, scope ASC LIMIT ${MAX_SCOPES}`,
    )
    .all() as Array<{ scope: string }>;

  const scopes = rows.map((row) => row.scope);
  if (scope === undefined) return { scopes };
  return {
    scopes,
    hint: `El ámbito "${scope}" no tiene nada que coincida. Repite la búsqueda sin scope o usa uno de los que aparecen en scopes.`,
  };
}

/**
 * The scope of a search as it arrived, before validation: the miss view only echoes it.
 * Shared by `recall` and `mem_search` so both read it the same way.
 */
export function requestedScope(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const scope = (args as Record<string, unknown>).scope;
  return typeof scope === "string" && scope !== "" ? scope : undefined;
}

/**
 * What a search answers: the hits, and on a miss the scopes that do hold content plus the
 * hint about the requested scope. `recall` and `mem_search` share it, so a client that still
 * uses the Engram alias gets the same way out of an empty answer as one on the canonical tool.
 */
export function searchResponse<T>(
  db: DB,
  hits: T[],
  scope: string | undefined,
): { hits: T[]; scopes?: string[]; hint?: string } {
  if (hits.length > 0) return { hits };
  return { hits, ...recallMissForModel(db, scope) };
}
