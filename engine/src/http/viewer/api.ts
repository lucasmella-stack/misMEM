// Read-only API for the interface: where each memory comes from. The queries live in
// engine/src/queries/; here the input is validated, the query called and the answer sent. Its
// salience is the effective one, as in recall; the stored one is the last checkpoint's.
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { getEmbeddingIndexStatus } from "../../embeddings/store.js";
import { loadEmbeddingConfig } from "../../embeddings/provider.js";
import { topics } from "../../queries/topics.js";
import { graphData, type GraphCaps } from "../../queries/graph.js";
import { listMemories, memoryDetail } from "../../queries/memories.js";
import { scopeCounts } from "../../queries/scopes.js";
import { traitDetail } from "../../queries/traits.js";
import { json } from "../respond.js";
import { clampLimit, parseOffset } from "./read.js";

export type { GraphCaps } from "../../queries/graph.js";

export type DetailPath = { layer: "memory" | "trait"; id: string };

/**
 * A detail path with a malformed id (a stray % or a half UTF-8 sequence) is the caller's
 * fault, not the server's: return "bad" for a 400 instead of letting decodeURIComponent
 * throw a URIError that the general catch disguises as a 500.
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

/**
 * Read-only view of the semantic index. It reads the config and the database only: the
 * provider URL may carry credentials, so it never leaves the server and no request is made.
 */
export function handleEmbeddings(db: DB, res: ServerResponse): void {
  const cfg = loadEmbeddingConfig();
  const status = getEmbeddingIndexStatus(db, cfg.model);
  json(res, 200, { enabled: cfg.enabled, model: cfg.model, ...status });
}

/** Out of (0,1) or unreadable falls back to the default: a cut of 9 would answer nothing. */
function parseMinScore(raw: string | null): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
}

export function handleTopics(db: DB, res: ServerResponse, url: URL): void {
  json(res, 200, {
    ...topics(db, {
      scope: url.searchParams.get("scope") ?? undefined,
      minScore: parseMinScore(url.searchParams.get("min_score")),
    }),
  });
}

export function handleScopes(db: DB, res: ServerResponse): void {
  json(res, 200, { scopes: scopeCounts(db) });
}

export function handleMemories(db: DB, res: ServerResponse, url: URL, at = Date.now()): void {
  const scope = url.searchParams.get("scope");
  const withNoise = url.searchParams.get("noise") === "1";
  const limit = clampLimit(url.searchParams.get("limit"), 50, 200);
  const offset = parseOffset(url.searchParams.get("offset"));

  json(res, 200, listMemories(db, { scope, withNoise, limit, offset, at }));
}

export function handleMemory(db: DB, res: ServerResponse, id: string, at = Date.now()): void {
  const detail = memoryDetail(db, id, at);
  if (!detail) {
    json(res, 404, { error: `no existe la memoria: ${id}` });
    return;
  }
  json(res, 200, detail);
}

export function handleTrait(db: DB, res: ServerResponse, id: string, at = Date.now()): void {
  const detail = traitDetail(db, id, at);
  if (!detail) {
    json(res, 404, { error: `no existe el rasgo: ${id}` });
    return;
  }
  json(res, 200, detail);
}

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

  json(res, 200, graphData(db, { scope, withEpisodes, withRelated, withCoUse, coUseMinN, at, caps }));
}
