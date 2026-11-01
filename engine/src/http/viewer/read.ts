// Read-only viewer API and the compiled interface. Nothing here writes; the actions (edit,
// unconsolidate, the two forgets, crystallize, start a consolidation) are in actions.ts. The
// queries live in engine/src/queries/: here the input is validated and the answer sent.
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { countPendingEpisodes, pendingEpisodes } from "../../memory/pending.js";
import { recentRows } from "../../queries/recent.js";
import { viewerStats } from "../../queries/stats.js";
import { recallHybrid } from "../../recall/recall.js";
import type { EmbedFn } from "../../embeddings/provider.js";
import { Layer } from "../../schema.js";
import { json } from "../respond.js";

// One source for the layer names: the Zod enum that validates them.
const LAYERS: readonly Layer[] = Layer.options;

function isLayer(v: string | null): v is Layer {
  return v !== null && (LAYERS as readonly string[]).includes(v);
}

export function clampLimit(raw: string | null, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

/**
 * An invalid or negative offset counts as 0; SQLite accepts neither NaN nor Infinity. Past
 * MAX_SAFE_INTEGER (1e20) it stops being an integer SQLite can bind, so it is clamped.
 */
export function parseOffset(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
}

export function handleStats(db: DB, res: ServerResponse): void {
  json(res, 200, viewerStats(db));
}

export function handleRecent(db: DB, res: ServerResponse, url: URL): void {
  const layerParam = url.searchParams.get("layer") ?? "episode";
  if (!isLayer(layerParam)) {
    json(res, 400, { error: `capa inválida: ${layerParam}` });
    return;
  }
  const layer: Layer = layerParam;
  const scope = url.searchParams.get("scope");
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);

  // Only episodes have a consolidation state: on the other layers `pending` changes nothing
  // and the response stays as it always was, without `total`.
  if (layer === "episode" && url.searchParams.get("pending") === "1") {
    const offset = parseOffset(url.searchParams.get("offset"));
    // The total counts every pending episode: the client pages with it, not with the page size.
    const total = countPendingEpisodes(db, scope);
    const rows = pendingEpisodes(db, scope, limit, offset);
    json(res, 200, { layer, scope, rows, total });
    return;
  }

  json(res, 200, { layer, scope, rows: recentRows(db, layer, scope, limit) });
}

export async function handleSearch(
  db: DB,
  res: ServerResponse,
  url: URL,
  embedFn?: EmbedFn,
  embeddingModel?: string,
): Promise<void> {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!query) {
    json(res, 400, { error: "falta q" });
    return;
  }
  const scope = url.searchParams.get("scope") ?? undefined;
  const limit = clampLimit(url.searchParams.get("limit"), 20, 50);
  try {
    const out = await recallHybrid(
      db,
      { query, scope, limit },
      embedFn,
      { reinforce: false, embeddingModel },
    );
    json(res, 200, out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
  }
}
