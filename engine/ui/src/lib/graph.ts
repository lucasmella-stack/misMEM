import type { GraphData } from "../api";

/**
 * What the panel lets you touch. `episodes` does not only hide the layer: it also decides
 * whether it is requested from the server, the only one that knows which episodes are pending.
 */
export interface GraphFilters {
  traits: boolean;
  orphans: boolean;
  related: boolean;
  episodes: boolean;
  /** The lateral layer: edges from measured co-use, which also light the drawing. */
  coUse: boolean;
  query: string;
  local: { enabled: boolean; depth: 1 | 2 | 3; centerId?: string };
}

/**
 * Below this many measured turns the sample is too short to compare one pair with another.
 * It does not cover a pair seen once: that one reads at the maximum however long the run.
 */
export const THIN_SAMPLE_TURNS = 20;

/**
 * How many ways in the panel lists. `GRAPH_MAX_HUBS` caps what the server sends and has to
 * stay at least this high, or the list runs short; `tests/ui-connectome.test.ts` checks it.
 */
export const PANEL_MAX_HUBS = 10;

/**
 * Where the canvas cuts a node label. The server already trimmed to `GRAPH_LABEL_CHARS`, which
 * has to stay at least this long or this cut becomes dead code without anyone noticing;
 * `tests/ui-graph.test.ts` fails if it stops.
 */
export const CANVAS_LABEL_CHARS = 48;

/** The fixed width of a `related` edge, read by `widthOfLink` and by the ceiling below. */
export const RELATED_EDGE_WIDTH = 0.7;

/**
 * The floor is what an unmeasured pair gets: drawn, because the pair exists, but saying nothing.
 * The ceiling is what the strongest measured association earns, and it has to beat
 * `RELATED_EDGE_WIDTH` so a measured path reads over a similar one.
 */
const EDGE_MIN_ALPHA = 0.2;
const EDGE_MIN_WIDTH = 0.7;
const EDGE_MAX_WIDTH = 3;

/**
 * How much of a pair's co-occurrence was repetition, in [0, 1). NPMI reads 1 both for "always
 * together" and for "once, and that was the only turn either appeared in", so strength alone
 * cannot tell evidence from coincidence. One sighting repeats nothing and is worth nothing.
 */
export function supportConfidence(n: number | undefined): number {
  if (n === undefined || n <= 1) return 0;
  return (n - 1) / n;
}

/**
 * How brightly a lateral edge is drawn. Only a positive association lights up: at zero the pair
 * is indistinguishable from chance and below it they avoid each other, and neither deserves ink.
 * Weighted by support, so an unrepeated pair falls to the same floor as one nobody measured.
 */
export function coUseGlow(
  strength: number | undefined,
  n?: number,
): { alpha: number; width: number } {
  const lit = Math.min(1, Math.max(0, strength ?? 0)) * supportConfidence(n);
  return {
    alpha: EDGE_MIN_ALPHA + (1 - EDGE_MIN_ALPHA) * lit,
    width: EDGE_MIN_WIDTH + (EDGE_MAX_WIDTH - EDGE_MIN_WIDTH) * lit,
  };
}

/**
 * A node's halo, normalized against the strongest in view: a graph of weak associations would
 * otherwise read as dark and one of strong associations as burnt, when what matters is who
 * stands out among what is drawn.
 */
export function hubGlow(strength: number | undefined, max: number, support?: number): number {
  if (max <= 0 || strength === undefined || strength <= 0) return 0;
  return Math.min(1, strength / max) * supportConfidence(support);
}

/**
 * What each node contributes to the lateral layer, over the edges given. Mirrors `hubs()` in
 * `engine/src/store/connectome.ts` on purpose, because the canvas draws a filtered subset the
 * server never saw; `tests/support.test.ts` fails if the two stop agreeing.
 */
export function accumulateCoUse(
  links: ReadonlyArray<{ source: string; target: string; kind: string; n?: number; strength?: number }>,
): Map<string, { degree: number; strength: number; support: number }> {
  const acc = new Map<string, { degree: number; strength: number; support: number }>();
  const bump = (id: string, strength: number, n: number): void => {
    const current = acc.get(id) ?? { degree: 0, strength: 0, support: 0 };
    current.degree += 1;
    if (strength > 0) current.strength += strength * supportConfidence(n);
    current.support = Math.max(current.support, n);
    acc.set(id, current);
  };
  for (const link of links) {
    if (link.kind !== "co_use") continue;
    bump(link.source, link.strength ?? 0, link.n ?? 0);
    bump(link.target, link.strength ?? 0, link.n ?? 0);
  }
  return acc;
}

/** A link at two moments: fresh from the API and already mutated by force-graph. */
type LinkEnd = string | { id: string };

const idOf = (end: LinkEnd): string => (typeof end === "string" ? end : end.id);

/**
 * One count per node of the edges actually drawn: the server only counts co-use degree, and only
 * with the connectome on, so the drawing counts what it has in front of it.
 */
export function visibleDegrees(links: Array<{ source: LinkEnd; target: LinkEnd }>): Map<string, number> {
  const degrees = new Map<string, number>();
  const bump = (id: string) => degrees.set(id, (degrees.get(id) ?? 0) + 1);
  for (const link of links) {
    bump(idOf(link.source));
    bump(idOf(link.target));
  }
  return degrees;
}

/** Direct neighbours, whether or not the library has already swapped ids for node objects. */
export function neighborsOf(links: Array<{ source: LinkEnd; target: LinkEnd }>, id: string): Set<string> {
  const neighbors = new Set<string>();
  for (const link of links) {
    const source = idOf(link.source);
    const target = idOf(link.target);
    if (source === id) neighbors.add(target);
    else if (target === id) neighbors.add(source);
  }
  return neighbors;
}

/**
 * The library's tooltip is injected as HTML: a label can never carry markup. Quotes are
 * escaped too, so this stays safe if a caller ever builds an attribute instead of a body.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/*
 * Twelve mid tones, one per scope, chosen to pass 3:1 (graphical object contrast) against the
 * four surfaces of both themes: #1a1917, #21201d, #cbc9c3 and #d6d3cc. A lighter tone vanishes
 * in light; a darker one, in dark.
 */
const SCOPE_COLORS = [
  "#d42300",
  "#946300",
  "#707030",
  "#447a0e",
  "#2f7c2f",
  "#127d47",
  "#157979",
  "#1c74a0",
  "#405df0",
  "#7860a9",
  "#a73ebb",
  "#b63d8d",
];

/**
 * Ranked by what is on screen: the palette is short, and spending it on the biggest topics
 * overall leaves a drawing where almost nothing is painted. The legend reads in this order too,
 * so both callers take it from here instead of each sorting its own copy.
 */
export function rankTopicsByDrawn<T extends { members: readonly string[] }>(
  topics: ReadonlyArray<T>,
  drawn?: ReadonlySet<string>,
): Array<{ topic: T; weight: number }> {
  return topics
    .map((topic) => ({
      topic,
      weight: drawn ? topic.members.filter((id) => drawn.has(id)).length : topic.members.length,
    }))
    .filter((t) => t.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

/**
 * The same colours keyed by memory instead of by scope, because a topic crosses scopes. Topics
 * arrive sorted by size; the ones past the palette stay unpainted rather than sharing a colour.
 */
export function topicPalette(
  topics: ReadonlyArray<{ members: readonly string[] }>,
  drawn?: ReadonlySet<string>,
): Map<string, string> {
  const ranked = rankTopicsByDrawn(topics, drawn);
  const palette = new Map<string, string>();
  for (const [index, { topic }] of ranked.entries()) {
    const color = SCOPE_COLORS[index];
    if (!color) break;
    for (const id of topic.members) palette.set(id, color);
  }
  return palette;
}

/** Spreads the twelve colours over the scopes with the most nodes; the rest get none. */
/** The slider hands back a number; the setting is a union, and its middle branch needs a home. */
export function asDepth(value: number): 1 | 2 | 3 {
  if (value >= 3) return 3;
  if (value <= 1) return 1;
  return 2;
}

export function scopePalette(scopes: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SCOPE_COLORS.length);
  const palette = new Map<string, string>();
  for (const [index, [scope]] of ranked.entries()) {
    const color = SCOPE_COLORS[index];
    if (color) palette.set(scope, color);
  }
  return palette;
}

/**
 * Returns a copy ready for force-graph, which mutates `source`/`target` and adds x/y to the nodes.
 * Order matters: trimming at the end would make the local graph walk links that already vanished
 * and the orphan filter count invisible links.
 */
export function filterGraph(data: GraphData, filters: GraphFilters): GraphData {
  const query = filters.query.trim().toLowerCase();

  // 1. Layers turned off.
  let nodes = data.nodes.filter((node) =>
    node.layer === "memory" || (node.layer === "trait" ? filters.traits : filters.episodes),
  );

  // 2. Query over label or scope, same as the list.
  if (query) {
    nodes = nodes.filter(
      (node) => node.label.toLowerCase().includes(query) || node.scope.toLowerCase().includes(query),
    );
  }
  let links = data.links.filter(
    (link) =>
      (filters.related || link.kind !== "related") && (filters.coUse || link.kind !== "co_use"),
  );

  // Links of a node that is gone count for nothing that follows.
  let alive = new Set(nodes.map((node) => node.id));
  links = links.filter((link) => alive.has(link.source) && alive.has(link.target));

  // 3. Local graph: only if the centre is still visible. If the query removed it, do not
  //    return an empty graph: local mode is ignored, as if it were off.
  const center = filters.local.centerId;
  if (filters.local.enabled && center && alive.has(center)) {
    const adjacency = new Map<string, string[]>();
    const connect = (from: string, to: string) => {
      const list = adjacency.get(from);
      if (list) list.push(to);
      else adjacency.set(from, [to]);
    };
    for (const link of links) {
      connect(link.source, link.target);
      connect(link.target, link.source);
    }

    const keep = new Set([center]);
    let frontier = [center];
    for (let step = 0; step < filters.local.depth; step++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (keep.has(neighbor)) continue;
          keep.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }

    nodes = nodes.filter((node) => keep.has(node.id));
    alive = new Set(keep);
    links = links.filter((link) => keep.has(link.source) && keep.has(link.target));
  }

  // 4. Without orphans: a node left with no link adds nothing to the drawing.
  if (!filters.orphans) {
    const linked = new Set(links.flatMap((link) => [link.source, link.target]));
    nodes = nodes.filter((node) => linked.has(node.id));
  }

  // 5. Last pass: no link may point to a node that is no longer painted.
  const visible = new Set(nodes.map((node) => node.id));
  links = links.filter((link) => visible.has(link.source) && visible.has(link.target));

  // 6. The server measured over everything it sent; this draws a subset. Keeping its figures
  //    would put the halo of a hub on a node left with one edge on screen.
  const own = accumulateCoUse(links);

  return {
    nodes: nodes.map((node) => {
      const { co_use, ...rest } = node;
      const mine = own.get(node.id);
      return mine ? { ...rest, co_use: mine } : rest;
    }),
    links: links.map((link) => ({ ...link })),
    truncated: { ...data.truncated },
  };
}
