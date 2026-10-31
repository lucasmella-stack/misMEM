import { describe, expect, it } from "vitest";
import type { GraphData, GraphLink, GraphNode } from "../ui/src/api";
import { escapeHtml, filterGraph, neighborsOf, type GraphFilters } from "../ui/src/lib/graph";

const node = (id: string, layer: GraphNode["layer"], label: string, scope = "s"): GraphNode => ({
  id,
  layer,
  scope,
  label,
});

const link = (source: string, target: string, kind: GraphLink["kind"] = "evidence"): GraphLink => ({
  source,
  target,
  kind,
});

const data = (nodes: GraphNode[], links: GraphLink[] = []): GraphData => ({
  nodes,
  links,
  truncated: { memories: false, traits: false, episodes: false },
});

const filters = (overrides: Partial<GraphFilters> = {}): GraphFilters => ({
  traits: true,
  orphans: true,
  related: true,
  episodes: true,
  coUse: true,
  query: "",
  local: { enabled: false, depth: 2 },
  ...overrides,
});

const ids = (graph: GraphData): string[] => graph.nodes.map((entry) => entry.id).sort();

describe("filterGraph", () => {
  it("con datos vacíos devuelve un grafo vacío con su truncated", () => {
    const out = filterGraph(data([]), filters());
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
    expect(out.truncated).toEqual({ memories: false, traits: false, episodes: false });
  });

  it("con traits: false quita los rasgos y sus aristas", () => {
    const out = filterGraph(
      data([node("m1", "memory", "una memoria"), node("t1", "trait", "un rasgo")], [link("m1", "t1")]),
      filters({ traits: false }),
    );
    expect(ids(out)).toEqual(["m1"]);
    expect(out.links).toEqual([]);
  });

  it("con el grafo local a profundidad 1 sobre A-B-C desde A deja A y B", () => {
    const out = filterGraph(
      data(
        [node("a", "memory", "a"), node("b", "memory", "b"), node("c", "memory", "c")],
        [link("a", "b"), link("b", "c")],
      ),
      filters({ local: { enabled: true, depth: 1, centerId: "a" } }),
    );
    expect(ids(out)).toEqual(["a", "b"]);
    expect(out.links).toHaveLength(1);
  });

  it("con el centro filtrado por la consulta devuelve el grafo filtrado, no uno vacío", () => {
    const out = filterGraph(
      data([node("a", "memory", "alfa"), node("b", "memory", "beta")], [link("a", "b")]),
      filters({ query: "alfa", local: { enabled: true, depth: 1, centerId: "b" } }),
    );
    expect(ids(out)).toEqual(["a"]);
  });

  it("con orphans: false quita los nodos sueltos", () => {
    const out = filterGraph(
      data([node("a", "memory", "a"), node("b", "memory", "b"), node("c", "memory", "c")], [link("a", "b")]),
      filters({ orphans: false }),
    );
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("no muta su entrada", () => {
    const input = data(
      [node("a", "memory", "alfa"), node("b", "memory", "beta"), node("t", "trait", "rasgo")],
      [link("a", "b", "related"), link("b", "t")],
    );
    const before = structuredClone(input);
    filterGraph(input, filters({ traits: false, related: false, orphans: false, query: "a" }));
    expect(input).toEqual(before);
  });
});

describe("neighborsOf", () => {
  it("acepta aristas cuyo source es un objeto", () => {
    const links = [
      { source: { id: "a" }, target: "b" },
      { source: "b", target: { id: "c" } },
    ];
    expect([...neighborsOf(links, "b")].sort()).toEqual(["a", "c"]);
  });
});

describe("escapeHtml", () => {
  it("escapa etiquetas, comillas y ampersands", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});
