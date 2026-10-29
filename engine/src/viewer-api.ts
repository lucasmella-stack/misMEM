/**
 * API de sólo lectura para la interfaz: de dónde sale cada recuerdo.
 *
 * Endpoints (misma auth y mismo filtro de Host que el resto de /api):
 *   GET /api/scopes          → ámbitos con sus conteos por capa
 *   GET /api/embeddings      → estado del índice semántico, sin hablar con el proveedor
 *   GET /api/memories        → memorias por salience efectiva (?scope=&limit=&offset=&noise=1)
 *   GET /api/memory/:id      → la memoria, sus episodios de origen y los rasgos que la citan
 *   GET /api/trait/:id       → el rasgo y las memorias que lo sostienen
 *   GET /api/graph           → nodos y aristas episodio → memoria → rasgo (?scope=&episodes=1),
 *                              memoria ↔ memoria por parecido (?related=1) y memoria ↔ memoria
 *                              por co-uso medido (?co_use=1, soporte con ?co_use_min_n=k), que
 *                              añade el grado de cada nodo y un resumen del tamaño de la
 *                              muestra; sin el parámetro no aparece nada de eso
 *
 * La salience que devuelve es la efectiva (con el decaimiento aplicado a hoy), la misma que
 * usa el recall. La guardada sólo es el valor del último checkpoint.
 */
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql, isNoiseGist } from "./noise.js";
import { coUseLinks, parseIds, relatedLinks, type GraphLink } from "./relations.js";
import { hubs, turnsRegistered } from "./connectome.js";
import { effectiveSalience, type SalienceRow } from "./salience.js";
import { getEmbeddingIndexStatus } from "./embeddings/store.js";
import { loadEmbeddingConfig } from "./embeddings/provider.js";
import { clampLimit, json, parseOffset } from "./viewer.js";

interface MemoryRow extends SalienceRow {
  id: string;
  scope: string;
  gist: string;
  details: string | null;
  source_episode_ids: string;
  use_count: number;
}

interface TraitRow {
  id: string;
  scope: string;
  name: string;
  strength: number;
  polarity: string;
  evidence_memory_ids: string;
  created_at: number;
  updated_at: number;
}

interface EpisodeRow {
  id: string;
  scope: string;
  body: string;
  created_at: number;
  consolidated_into: string | null;
}

const MEMORY_COLUMNS =
  "id, scope, gist, details, source_episode_ids, salience, use_count, created_at, last_accessed_at, salience_updated_at";
const GRAPH_MAX_MEMORIES = 400;
const GRAPH_MAX_TRAITS = 200;
const GRAPH_MAX_EPISODES = 2000;
const GRAPH_LABEL_CHARS = 120;

const GRAPH_MAX_HUBS = 20;

/** Topes por capa; los tests los bajan para no sembrar cientos de filas. */
export interface GraphCaps {
  memories?: number;
  traits?: number;
  episodes?: number;
}

export type DetailPath = { layer: "memory" | "trait"; id: string };

/**
 * Una ruta de detalle con el id mal codificado (% suelto o una secuencia UTF-8 a medias)
 * es culpa de quien llama, no del servidor: devuelve "bad" para responder 400 en vez de
 * dejar que decodeURIComponent lance URIError y el catch general lo disfrace de 500.
 */
export function parseDetailPath(pathname: string): DetailPath | "bad" | null {
  const match = /^\/api\/(memory|trait)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2] ?? "");
    return id ? { layer: match[1] as DetailPath["layer"], id } : "bad";
  } catch {
    return "bad";
  }
}

function countBy(db: DB, sql: string): Map<string, number> {
  const rows = db.prepare(sql).all() as Array<{ key: string; n: number }>;
  return new Map(rows.map((r) => [r.key, r.n]));
}

/** Cuántos rasgos citan a cada memoria. */
function traitCounts(db: DB): Map<string, number> {
  return countBy(
    db,
    `SELECT j.value AS key, COUNT(*) AS n
     FROM traits t, json_each(t.evidence_memory_ids) j GROUP BY j.value`,
  );
}

/** Cuántos episodios siguen atados a cada memoria (los demás ya los borró forget). */
function episodeCounts(db: DB): Map<string, number> {
  return countBy(
    db,
    `SELECT consolidated_into AS key, COUNT(*) AS n
     FROM episodes WHERE consolidated_into IS NOT NULL GROUP BY consolidated_into`,
  );
}

function memoryView(row: MemoryRow, at: number) {
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

function traitView(row: TraitRow) {
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

/**
 * Read-only view of the semantic index. It reads the config and the database only: the
 * provider URL may carry credentials, so it never leaves the server and no request is made.
 */
export function handleEmbeddings(db: DB, res: ServerResponse): void {
  const cfg = loadEmbeddingConfig();
  const status = getEmbeddingIndexStatus(db, cfg.model);
  json(res, 200, {
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model,
    ...status,
  });
}

export function handleScopes(db: DB, res: ServerResponse): void {
  const scopes = new Map<
    string,
    { scope: string; episodes_pending: number; episodes_consolidated: number; memories: number; traits: number }
  >();
  const entry = (scope: string) => {
    let e = scopes.get(scope);
    if (!e) {
      e = { scope, episodes_pending: 0, episodes_consolidated: 0, memories: 0, traits: 0 };
      scopes.set(scope, e);
    }
    return e;
  };
  for (const r of db
    .prepare(
      `SELECT scope, SUM(consolidated_into IS NULL) AS pending, SUM(consolidated_into IS NOT NULL) AS done
       FROM episodes GROUP BY scope`,
    )
    .all() as Array<{ scope: string; pending: number; done: number }>) {
    entry(r.scope).episodes_pending = r.pending;
    entry(r.scope).episodes_consolidated = r.done;
  }
  for (const r of db
    .prepare(`SELECT scope, COUNT(*) AS n FROM memories m WHERE ${excludeNoiseSql("m")} GROUP BY scope`)
    .all() as Array<{ scope: string; n: number }>) {
    entry(r.scope).memories = r.n;
  }
  for (const r of db.prepare("SELECT scope, COUNT(*) AS n FROM traits GROUP BY scope").all() as Array<{
    scope: string;
    n: number;
  }>) {
    entry(r.scope).traits = r.n;
  }
  const list = [...scopes.values()].sort((a, b) => a.scope.localeCompare(b.scope));
  json(res, 200, { scopes: list });
}

export function handleMemories(db: DB, res: ServerResponse, url: URL, at = Date.now()): void {
  const scope = url.searchParams.get("scope");
  const withNoise = url.searchParams.get("noise") === "1";
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);
  const offset = parseOffset(url.searchParams.get("offset"));

  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories m
       WHERE (@scope IS NULL OR scope = @scope) ${withNoise ? "" : `AND ${excludeNoiseSql("m")}`}`,
    )
    .all({ scope }) as MemoryRow[];
  const traits = traitCounts(db);
  const episodes = episodeCounts(db);
  const memories = rows
    .map((row) => ({
      ...memoryView(row, at),
      sources: parseIds(row.source_episode_ids).length,
      episodes_left: episodes.get(row.id) ?? 0,
      traits: traits.get(row.id) ?? 0,
    }))
    // Por la salience de hoy, como el recall; a igualdad, lo más nuevo primero.
    .sort((a, b) => b.salience - a.salience || b.created_at - a.created_at || a.id.localeCompare(b.id));

  json(res, 200, { total: memories.length, memories: memories.slice(offset, offset + limit) });
}

export function handleMemory(db: DB, res: ServerResponse, id: string, at = Date.now()): void {
  const row = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
  if (!row) {
    json(res, 404, { error: `no existe la memoria: ${id}` });
    return;
  }

  // Las fuentes que la memoria declara y las que todavía apuntan a ella; si forget ya
  // borró alguna, queda marcada en vez de desaparecer de la cadena.
  const getEpisode = db.prepare(
    "SELECT id, scope, body, created_at, consolidated_into FROM episodes WHERE id = ?",
  );
  const declared = parseIds(row.source_episode_ids);
  const linked = db
    .prepare("SELECT id FROM episodes WHERE consolidated_into = ? ORDER BY created_at")
    .all(id) as Array<{ id: string }>;
  const ids = [...new Set([...declared, ...linked.map((e) => e.id)])];
  const episodes = ids.map((episodeId) => {
    const e = getEpisode.get(episodeId) as EpisodeRow | undefined;
    if (!e) return { id: episodeId, missing: true as const };
    return {
      id: e.id,
      scope: e.scope,
      text: e.body,
      created_at: e.created_at,
      // Un episodio re-consolidado en otra memoria sigue en la lista, pero se nota.
      linked_here: e.consolidated_into === id,
    };
  });

  const traits = (
    db
      .prepare(
        `SELECT DISTINCT t.id, t.scope, t.name, t.strength, t.polarity, t.evidence_memory_ids,
                t.created_at, t.updated_at
         FROM traits t, json_each(t.evidence_memory_ids) j WHERE j.value = ?
         ORDER BY t.strength DESC, t.updated_at DESC`,
      )
      .all(id) as TraitRow[]
  ).map(traitView);

  // Only the detail needs the vector metadata: the lists would pay one query per row for
  // something they do not show.
  const embedding = db
    .prepare("SELECT model, dims, created_at FROM memory_embeddings WHERE memory_id = ?")
    .get(id) as { model: string; dims: number; created_at: number } | undefined;

  json(res, 200, {
    memory: { ...memoryView(row, at), embedding: embedding ?? null },
    episodes,
    traits,
  });
}

export function handleTrait(db: DB, res: ServerResponse, id: string, at = Date.now()): void {
  const row = db
    .prepare(
      "SELECT id, scope, name, strength, polarity, evidence_memory_ids, created_at, updated_at FROM traits WHERE id = ?",
    )
    .get(id) as TraitRow | undefined;
  if (!row) {
    json(res, 404, { error: `no existe el rasgo: ${id}` });
    return;
  }
  const getMemory = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`);
  const evidence = parseIds(row.evidence_memory_ids).map((memoryId) => {
    const m = getMemory.get(memoryId) as MemoryRow | undefined;
    return m ? memoryView(m, at) : { id: memoryId, missing: true as const };
  });
  json(res, 200, { trait: traitView(row), evidence });
}

const label = (text: string): string =>
  text.length > GRAPH_LABEL_CHARS ? `${text.slice(0, GRAPH_LABEL_CHARS - 1)}…` : text;

export function handleGraph(
  db: DB,
  res: ServerResponse,
  url: URL,
  at = Date.now(),
  caps: GraphCaps = {},
): void {
  const scope = url.searchParams.get("scope");
  const withEpisodes = url.searchParams.get("episodes") === "1";
  const withRelated = url.searchParams.get("related") === "1";
  // The co-use layer is opt-in: without the parameter the response does not change at
  // all, because this is the contract the interface already consumes.
  const withCoUse = url.searchParams.get("co_use") === "1";
  const coUseMinN = Math.max(1, Number(url.searchParams.get("co_use_min_n") ?? 1) || 1);
  const maxMemories = caps.memories ?? GRAPH_MAX_MEMORIES;
  const maxTraits = caps.traits ?? GRAPH_MAX_TRAITS;
  const maxEpisodes = caps.episodes ?? GRAPH_MAX_EPISODES;

  // Los totales se cuentan antes de recortar: una capa truncada es la que tenía más filas
  // que su tope, no la que justo lo llenaba.
  const memoriesWhere = `(@scope IS NULL OR scope = @scope) AND ${excludeNoiseSql("m")}`;
  const memoryTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${memoriesWhere}`).get({ scope }) as { n: number }
  ).n;
  const memories = (
    db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories m WHERE ${memoriesWhere}`)
      .all({ scope }) as MemoryRow[]
  )
    .map((row) => ({ row, salience: effectiveSalience(row, at) }))
    .sort((a, b) => b.salience - a.salience)
    .slice(0, maxMemories);
  const traitTotal = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM traits WHERE (@scope IS NULL OR scope = @scope)`)
      .get({ scope }) as { n: number }
  ).n;
  const traits = db
    .prepare(
      `SELECT id, scope, name, strength, polarity, evidence_memory_ids, created_at, updated_at FROM traits
       WHERE (@scope IS NULL OR scope = @scope) ORDER BY strength DESC LIMIT @limit`,
    )
    .all({ scope, limit: maxTraits }) as TraitRow[];

  const truncated = {
    memories: memoryTotal > maxMemories,
    traits: traitTotal > maxTraits,
    episodes: false,
  };

  const nodes: Array<Record<string, unknown>> = [];
  const links: GraphLink[] = [];
  const memoryIds = new Set(memories.map((m) => m.row.id));

  for (const { row, salience } of memories) {
    nodes.push({ id: row.id, layer: "memory", scope: row.scope, label: label(row.gist), salience });
  }
  for (const t of traits) {
    nodes.push({ id: t.id, layer: "trait", scope: t.scope, label: label(t.name), strength: t.strength });
    for (const memoryId of parseIds(t.evidence_memory_ids)) {
      if (memoryIds.has(memoryId)) links.push({ source: memoryId, target: t.id, kind: "evidence" });
    }
  }
  if (withEpisodes && memoryIds.size > 0) {
    const idsJson = JSON.stringify([...memoryIds]);
    // Los episodios del grafo son los que cuelgan de las memorias visibles; el recorte
    // ocurre sobre ese conjunto, así que el total se cuenta con el mismo WHERE.
    const episodeTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM episodes
           WHERE consolidated_into IN (SELECT value FROM json_each(?))`,
        )
        .get(idsJson) as { n: number }
    ).n;
    truncated.episodes = episodeTotal > maxEpisodes;
    const episodes = db
      .prepare(
        `SELECT id, scope, body, created_at, consolidated_into FROM episodes
         WHERE consolidated_into IN (SELECT value FROM json_each(?))
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(idsJson, maxEpisodes) as EpisodeRow[];
    for (const e of episodes) {
      nodes.push({ id: e.id, layer: "episode", scope: e.scope, label: label(e.body) });
      links.push({ source: e.id, target: e.consolidated_into as string, kind: "origin" });
    }
  }

  if (withRelated) links.push(...relatedLinks(db, [...memoryIds]));

  if (!withCoUse) {
    json(res, 200, { nodes, links, truncated });
    return;
  }

  const drawn = [...memoryIds];
  const lateral = coUseLinks(db, drawn, coUseMinN);
  const degrees = new Map<string, { degree: number; strength: number }>();
  for (const link of lateral) {
    for (const id of [link.source, link.target]) {
      const current = degrees.get(id) ?? { degree: 0, strength: 0 };
      current.degree += 1;
      if ((link.strength ?? 0) > 0) current.strength += link.strength ?? 0;
      degrees.set(id, current);
    }
  }
  links.push(...lateral);

  json(res, 200, {
    nodes: nodes.map((node) => {
      const own = degrees.get(node.id as string);
      return own ? { ...node, co_use: own } : node;
    }),
    links,
    truncated,
    // The side panels must not present noise as topology: with few turns, a pair seen
    // once scores maximum strength by construction.
    connectome: {
      turns: turnsRegistered(db),
      pairs: coUseLinks(db, drawn, 1).length,
      shown: lateral.length,
      min_n: coUseMinN,
      hubs: hubs(db, { ids: drawn, minN: coUseMinN }).slice(0, GRAPH_MAX_HUBS),
    },
  });
}
