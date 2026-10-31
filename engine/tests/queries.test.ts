import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { viewerStats, statsSummary, ingestStats } from "../src/queries/stats.js";
import { recentRows } from "../src/queries/recent.js";
import { scopeCounts } from "../src/queries/scopes.js";
import { listMemories, memoryDetail, memoryScopes } from "../src/queries/memories.js";
import { traitDetail } from "../src/queries/traits.js";
import { graphData } from "../src/queries/graph.js";
import { forgetImpact } from "../src/queries/forget-impact.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function memoryFrom(scope: string, gist: string, bodies: string[]): { memoryId: string; episodeIds: string[] } {
  const episodeIds = bodies.map((body) => capture(db, { scope, body }).id);
  const { memory_id } = consolidate(db, { scope, gist, source_episode_ids: episodeIds });
  return { memoryId: memory_id, episodeIds };
}

describe("queries/stats", () => {
  it("viewerStats counts each layer and keeps the newest episode", () => {
    expect(viewerStats(db)).toEqual({
      counts: { episodes: 0, memories: 0, traits: 0, consolidated: 0 },
      topScopes: [],
      last: null,
    });

    capture(db, { scope: "a", body: "uno" });
    capture(db, { scope: "a", body: "dos" });
    capture(db, { scope: "b", body: "tres" });
    const done = capture(db, { scope: "b", body: "hecho" });
    consolidate(db, { scope: "b", gist: "memoria", source_episode_ids: [done.id] });

    const stats = viewerStats(db);
    expect(stats.counts).toEqual({ episodes: 4, memories: 1, traits: 0, consolidated: 1 });
    expect(stats.topScopes[0]).toEqual({ scope: "a", n: 2 });
    expect(stats.last).toMatchObject({ scope: "b" });
  });

  it("statsSummary keeps the CLI shape, filters by scope prefix and reports the range", () => {
    capture(db, { scope: "engram/uno", body: "uno" });
    capture(db, { scope: "engram/dos", body: "dos" });
    capture(db, { scope: "otro", body: "tres" });

    const all = statsSummary(db, undefined);
    expect(all).toMatchObject({
      episodes_total: 3,
      episodes_unconsolidated: 3,
      memories_total: 0,
      traits_total: 0,
    });
    expect(all.scopes.map((s) => s.count).sort()).toEqual([1, 1, 1]);
    expect(all.oldest_episode_ts).not.toBeNull();
    expect(all.oldest_episode_ts! <= all.newest_episode_ts!).toBe(true);

    const filtered = statsSummary(db, "engram/");
    expect(filtered.episodes_total).toBe(2);
    expect(filtered.scopes.map((s) => s.scope).sort()).toEqual(["engram/dos", "engram/uno"]);
  });

  it("ingestStats counts the layers the ingest CLI prints", () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1"]);
    crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const stats = ingestStats(db);
    expect(stats).toMatchObject({ episodes: 1, memories: 1, traits: 1 });
    expect(stats.top_scopes).toEqual([{ scope: "a", n: 1 }]);
  });
});

describe("queries/recent", () => {
  it("returns the rows of each layer with the shape the viewer prints", () => {
    const episode = capture(db, { scope: "a", body: "un episodio" });
    const { memory_id: memoryId } = consolidate(db, { scope: "a", gist: "una memoria", source_episode_ids: [episode.id] });
    const trait = crystallize(db, { scope: "a", name: "un rasgo", evidence_memory_ids: [memoryId] });

    expect(recentRows(db, "episode", null, 10)).toMatchObject([
      { id: episode.id, scope: "a", text: "un episodio", consolidated_into: memoryId },
    ]);
    expect(recentRows(db, "memory", "a", 10)).toMatchObject([
      { id: memoryId, scope: "a", text: "una memoria" },
    ]);
    expect(recentRows(db, "trait", "a", 10)).toMatchObject([
      { id: trait.trait_id, scope: "a", text: "un rasgo", strength: 1 },
    ]);
    expect(recentRows(db, "episode", "otro", 10)).toEqual([]);
  });
});

describe("queries/scopes", () => {
  it("counts per layer and scope, leaving noise out of the memories", () => {
    memoryFrom("a", "una", ["e1", "e2"]);
    memoryFrom("a", "[noise] ruido", ["e3"]);
    capture(db, { scope: "b", body: "pendiente" });

    expect(scopeCounts(db)).toEqual([
      { scope: "a", episodes_pending: 0, episodes_consolidated: 3, memories: 1, traits: 0 },
      { scope: "b", episodes_pending: 1, episodes_consolidated: 0, memories: 0, traits: 0 },
    ]);
  });
});

describe("queries/memories", () => {
  it("lists memories with their source chain and hides noise unless asked", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "con fuentes", ["e1", "e2"]);
    memoryFrom("a", "[pareto:l0] filtrada", ["e3"]);
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[0]);
    crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const list = listMemories(db, { scope: null, withNoise: false, limit: 50, offset: 0, at: Date.now() });
    expect(list.total).toBe(1);
    expect(list.memories[0]).toMatchObject({
      id: memoryId,
      text: "con fuentes",
      sources: 2,
      episodes_left: 1,
      traits: 1,
      noise: false,
    });

    expect(listMemories(db, { scope: "a", withNoise: true, limit: 1, offset: 1, at: Date.now() }).memories).toHaveLength(1);
  });

  it("returns the memory, its episodes (marking the gone ones) and the traits that cite it", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "la memoria", ["primero", "segundo"]);
    const trait = crystallize(db, { scope: "a", name: "el rasgo", evidence_memory_ids: [memoryId] });
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[0]);

    const detail = memoryDetail(db, memoryId, Date.now());
    expect(detail?.memory).toMatchObject({ id: memoryId, text: "la memoria" });
    expect(detail?.episodes).toEqual([
      { id: episodeIds[0], missing: true },
      { id: episodeIds[1], scope: "a", text: "segundo", created_at: expect.any(Number), linked_here: true },
    ]);
    expect(detail?.traits.map((t) => t.id)).toEqual([trait.trait_id]);
    expect(memoryDetail(db, "NOPE", Date.now())).toBeNull();
  });

  it("reads the scopes of the ids it is given", () => {
    const { memoryId } = memoryFrom("a", "una", ["e1"]);
    expect(memoryScopes(db, [memoryId, "NOPE"])).toEqual([{ id: memoryId, scope: "a" }]);
    expect(memoryScopes(db, [])).toEqual([]);
  });
});

describe("queries/traits", () => {
  it("returns the trait and its evidence, marking the memories that no longer exist", () => {
    const { memoryId } = memoryFrom("a", "evidencia", ["e1"]);
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId, "BORRADA"] });

    const detail = traitDetail(db, trait.trait_id, Date.now());
    expect(detail?.trait).toMatchObject({ id: trait.trait_id, text: "rasgo", strength: 2 });
    expect(detail?.evidence[0]).toMatchObject({ id: memoryId, text: "evidencia" });
    expect(detail?.evidence[1]).toEqual({ id: "BORRADA", missing: true });
    expect(traitDetail(db, "NOPE", Date.now())).toBeNull();
  });
});

describe("queries/graph", () => {
  const base = {
    scope: null,
    withEpisodes: false,
    withRelated: false,
    withCoUse: false,
  } as const;

  it("draws memories, traits and their evidence edges, and only marks a layer when it is cut", () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1"]);
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const graph = graphData(db, { ...base, at: Date.now() });
    expect(graph.nodes.map((n) => [n.id, n.layer])).toEqual([
      [memoryId, "memory"],
      [trait.trait_id, "trait"],
    ]);
    expect(graph.links).toEqual([{ source: memoryId, target: trait.trait_id, kind: "evidence" }]);
    expect(graph.truncated).toEqual({ memories: false, traits: false, episodes: false });
    expect(graph.connectome).toBeUndefined();

    // Exactly the cap is not a truncation.
    expect(graphData(db, { ...base, at: Date.now(), caps: { memories: 1 } }).truncated.memories).toBe(false);
    memoryFrom("a", "otra", ["e2"]);
    expect(graphData(db, { ...base, at: Date.now(), caps: { memories: 1 } }).truncated.memories).toBe(true);
  });

  it("adds the episode layer only when asked for and counts its total before cutting", () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1", "e2"]);
    crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const without = graphData(db, { ...base, at: Date.now(), caps: { episodes: 1 } });
    expect(without.nodes.filter((n) => n.layer === "episode")).toHaveLength(0);

    const withEpisodes = graphData(db, { ...base, withEpisodes: true, at: Date.now(), caps: { episodes: 1 } });
    expect(withEpisodes.nodes.filter((n) => n.layer === "episode")).toHaveLength(1);
    expect(withEpisodes.truncated.episodes).toBe(true);
  });
});

describe("queries/forget-impact", () => {
  it("counts what forgetting a memory or a trait would take with it", () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1", "e2"]);
    const t1 = crystallize(db, { scope: "a", name: "uno", evidence_memory_ids: [memoryId] });
    crystallize(db, { scope: "a", name: "dos", evidence_memory_ids: [memoryId] });

    expect(forgetImpact(db, "memory", memoryId)).toEqual({ episodes: 2, traits_citing: 2 });
    expect(forgetImpact(db, "trait", t1.trait_id)).toEqual({ memories_cited: 1 });
  });
});
