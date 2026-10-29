/**
 * misMEM viewer — API de lectura y UI compilada.
 *
 * Endpoints (todos detrás de la misma BasicAuth de /mcp):
 *   GET /viewer            → la interfaz compilada (ui/ → dist/ui), ver viewer-static.ts
 *   GET /api/stats         → totales por capa + top scopes
 *   GET /api/recent        → últimas N filas de una capa (?layer=&scope=&limit=&offset=);
 *                            `offset` sólo aplica a rasgos y a episodios con pending=1
 *   GET /api/search        → recall híbrido read-only (?q=&scope=&limit=), con `truncated`
 *   El resto de GET /api/* (scopes, memories, memory/:id, trait/:id, graph) vive en viewer-api.ts.
 *
 * Nada de acá escribe: las acciones (editar, desconsolidar, los dos forget en dos
 * pasos, cristalizar, lanzar una consolidación) viven en viewer-actions.ts.
 *
 * Cero dependencias nuevas.
 */
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { countPendingEpisodes, pendingEpisodes, recallHybrid } from "./tools.js";
import type { EmbedFn } from "./embeddings/provider.js";
import { Layer } from "./schema.js";

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

export function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * Un offset inválido o negativo cuenta como 0; SQLite no acepta NaN ni Infinity. Pasado
 * MAX_SAFE_INTEGER (1e20) deja de ser un entero que SQLite pueda bindear: se recorta.
 */
export function parseOffset(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0;
}

export function handleStats(db: DB, res: ServerResponse): void {
  const counts = {
    episodes: (
      db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }
    ).n,
    memories: (
      db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
    ).n,
    traits: (
      db.prepare("SELECT COUNT(*) AS n FROM traits").get() as { n: number }
    ).n,
    consolidated: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NOT NULL",
        )
        .get() as { n: number }
    ).n,
  };
  const topScopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n FROM episodes
       GROUP BY scope ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ scope: string; n: number }>;
  const last = db
    .prepare(
      "SELECT id, scope, created_at FROM episodes ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { id: string; scope: string; created_at: number } | undefined;
  json(res, 200, { counts, topScopes, last: last ?? null });
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

  // Sólo los episodios tienen estado de consolidación: en las otras capas `pending` no
  // cambia nada y la respuesta sigue siendo la de siempre, sin `total`.
  if (layer === "episode" && url.searchParams.get("pending") === "1") {
    const offset = parseOffset(url.searchParams.get("offset"));
    // El total es el de todos los pendientes: el cliente pagina con él, no con el tamaño de la página.
    const total = countPendingEpisodes(db, scope);
    const rows = pendingEpisodes(db, scope, limit, offset);
    json(res, 200, { layer, scope, rows, total });
    return;
  }

  let rows: unknown[];
  if (layer === "episode") {
    rows = db
      .prepare(
        `SELECT id, scope, body AS text, created_at, consolidated_into
         FROM episodes
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  } else if (layer === "memory") {
    rows = db
      .prepare(
        `SELECT id, scope, gist AS text, details, salience, created_at, last_accessed_at
         FROM memories
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY salience DESC, created_at DESC LIMIT @limit`,
      )
      .all({ scope, limit });
  } else {
    const offset = parseOffset(url.searchParams.get("offset"));
    // The total uses the same filter as the rows: the client pages with it, which is how it
    // tells "nothing else" from "on the next page".
    const { n: total } = db
      .prepare("SELECT COUNT(*) AS n FROM traits WHERE (@scope IS NULL OR scope = @scope)")
      .get({ scope }) as { n: number };
    // `id` breaks the tie: traits crystallized in the same millisecond share strength and
    // updated_at, and a partial order can make two pages repeat one row and skip another.
    rows = db
      .prepare(
        `SELECT id, scope, name AS text, strength, polarity, created_at, updated_at
         FROM traits
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY strength DESC, updated_at DESC, id DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ scope, limit, offset });
    json(res, 200, { layer, scope, rows, total });
    return;
  }
  json(res, 200, { layer, scope, rows });
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
    // A full page cannot tell "exactly these" from "more below", so the client says it may be cut.
    json(res, 200, { ...out, limit, truncated: out.hits.length >= limit });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
  }
}
