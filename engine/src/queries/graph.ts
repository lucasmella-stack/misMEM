// The graph the viewer draws: memory → trait evidence edges, optional origin episodes, optional
// similarity and co-use layers. Totals are counted before the caps cut, so a truncated layer is
// the one that had more rows than its cap, not the one that just filled it.
import type { Database as DB } from "better-sqlite3";
import { coUseLinks, parseIds, relatedLinks, type GraphLink } from "./relations.js";
import { integerFloor } from "../domain/support.js";
import { coUsePairs, hubs, turnsRegistered, type Hub } from "../store/connectome.js";
import {
  excludeNoiseSql,
  MEMORY_NODE_COLUMNS,
  type ConsolidatedEpisodeRow,
  type MemoryNodeRow,
  type TraitRow,
} from "../store/rows.js";
import { effectiveSalience } from "../memory/salience.js";

const GRAPH_MAX_MEMORIES = 400;
const GRAPH_MAX_TRAITS = 200;
const GRAPH_MAX_EPISODES = 2000;
/** Trimmed again on the canvas to `CANVAS_LABEL_CHARS`: this has to stay the longer. */
export const GRAPH_LABEL_CHARS = 120;
/** Sent to the panel, which lists `PANEL_MAX_HUBS` of them: this has to stay the larger. */
export const GRAPH_MAX_HUBS = 20;

/** Caps per layer; the tests lower them so they do not seed hundreds of rows. */
export interface GraphCaps {
  memories?: number;
  traits?: number;
  episodes?: number;
}

export interface GraphQuery {
  scope: string | null;
  withEpisodes: boolean;
  withRelated: boolean;
  withCoUse: boolean;
  /** Minimum co-use strength; the caller already normalized it from the query parameter. */
  coUseMinN?: number;
  at?: number;
  caps?: GraphCaps;
}

interface GraphNode {
  id: string;
  layer: "memory" | "trait" | "episode";
  scope: string;
  label: string;
  salience?: number;
  strength?: number;
  co_use?: { degree: number; strength: number; support: number };
}

export interface GraphBody {
  nodes: GraphNode[];
  links: GraphLink[];
  truncated: { memories: boolean; traits: boolean; episodes: boolean };
  connectome?: {
    turns: number;
    pairs: number;
    shown: number;
    min_n: number;
    /** Best support among the edges drawn: with every pair at 1, no figure above means anything. */
    max_n: number;
    hubs: Hub[];
  };
}

const label = (text: string): string =>
  text.length > GRAPH_LABEL_CHARS ? `${text.slice(0, GRAPH_LABEL_CHARS - 1)}…` : text;

export function graphData(db: DB, query: GraphQuery): GraphBody {
  const { scope } = query;
  const at = query.at ?? Date.now();
  // A floor arrives from the query string: `1e400` parses as Infinity, which SQLite matches
  // against nothing and JSON serialises as null, leaving a hole where the panel prints it.
  const coUseMinN = integerFloor(query.coUseMinN);
  const maxMemories = query.caps?.memories ?? GRAPH_MAX_MEMORIES;
  const maxTraits = query.caps?.traits ?? GRAPH_MAX_TRAITS;
  const maxEpisodes = query.caps?.episodes ?? GRAPH_MAX_EPISODES;

  const memoriesWhere = `(@scope IS NULL OR scope = @scope) AND ${excludeNoiseSql("m")}`;
  const memoryTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${memoriesWhere}`).get({ scope }) as { n: number }
  ).n;
  const memories = (
    db
      .prepare(`SELECT ${MEMORY_NODE_COLUMNS} FROM memories m WHERE ${memoriesWhere}`)
      .all({ scope }) as MemoryNodeRow[]
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

  const nodes: GraphNode[] = [];
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
  if (query.withEpisodes && memoryIds.size > 0) {
    const idsJson = JSON.stringify([...memoryIds]);
    // The graph's episodes are those hanging from the visible memories; the cut happens over
    // that set, so the total is counted with the same WHERE.
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
      .all(idsJson, maxEpisodes) as ConsolidatedEpisodeRow[];
    for (const e of episodes) {
      nodes.push({ id: e.id, layer: "episode", scope: e.scope, label: label(e.body) });
      links.push({ source: e.id, target: e.consolidated_into, kind: "origin" });
    }
  }

  if (query.withRelated) links.push(...relatedLinks(db, [...memoryIds]));

  if (!query.withCoUse) return { nodes, links, truncated };

  const drawn = [...memoryIds];
  const lateral = coUseLinks(db, drawn, coUseMinN);
  links.push(...lateral);

  // One accumulator for the whole lateral layer, in the module that owns it: the halo on the
  // canvas and the list in the panel have to answer to the same definition of a hub.
  const ranked = hubs(db, { ids: drawn, minN: coUseMinN });
  const byId = new Map(ranked.map((hub) => [hub.id, hub]));

  return {
    nodes: nodes.map((node) => {
      const own = byId.get(node.id);
      return own
        ? { ...node, co_use: { degree: own.degree, strength: own.strength, support: own.support } }
        : node;
    }),
    links,
    truncated,
    // Nothing here may present noise as topology: a pair seen once scores maximum strength by
    // construction, so the support travels beside every figure that depends on it.
    connectome: {
      turns: turnsRegistered(db),
      pairs: coUsePairs(db),
      shown: lateral.length,
      min_n: coUseMinN,
      max_n: lateral.reduce((top, link) => Math.max(top, link.n ?? 0), 0),
      hubs: ranked.slice(0, GRAPH_MAX_HUBS),
    },
  };
}
