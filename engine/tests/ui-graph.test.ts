import { describe, expect, it } from "vitest";
import type { GraphData, GraphLink, GraphNode } from "../ui/src/api";
import { escapeHtml, filterGraph, neighborsOf, scopePalette, type GraphFilters } from "../ui/src/lib/graph";
import { CANVAS_LABEL_CHARS, topicPalette, visibleDegrees } from "../ui/src/lib/graph";
import { pointerRadius, radiusOf, type Node } from "../ui/src/components/graph/paint";
import { GRAPH_LABEL_CHARS } from "../src/queries/graph.js";

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

describe("escape de una etiqueta", () => {
  it("escapa también la comilla simple", () => {
    // The tooltip is injected as innerHTML. Today the label is the whole content, where & < >
    // suffice, but the day someone builds an attribute with this the quote closes it.
    expect(escapeHtml("d'Artagnan")).toBe("d&#39;Artagnan");
  });

  it("no escapa dos veces lo que ya venía escapado", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("topes de la etiqueta", () => {
  it("el servidor manda al menos lo que el lienzo recorta", () => {
    // Two cuts for one label: if the server's drops below the canvas's, the canvas cut stops
    // running and nothing says so.
    expect(GRAPH_LABEL_CHARS).toBeGreaterThanOrEqual(CANVAS_LABEL_CHARS);
  });
});

describe("paleta por ámbito", () => {
  it("reparte los colores por cantidad de nodos", () => {
    const paleta = scopePalette(["a", "a", "a", "b", "b", "c"]);

    expect(paleta.get("a")).toBeTruthy();
    expect(paleta.get("b")).toBeTruthy();
    expect(paleta.get("a")).not.toBe(paleta.get("b"));
  });

  it("con más ámbitos que colores los últimos se quedan sin color, no con uno repetido", () => {
    // Thirteen scopes against twelve tones: the branch that leaves one out had never run.
    const ambitos = Array.from({ length: 13 }, (_, i) => `s${i}`).flatMap((s, i) =>
      Array.from({ length: 13 - i }, () => s),
    );
    const paleta = scopePalette(ambitos);

    expect(paleta.size).toBe(12);
    expect(paleta.get("s12")).toBeUndefined();
    expect(new Set(paleta.values()).size).toBe(12);
  });
});

describe("el tamaño de un nodo", () => {
  const degrees = (links: GraphLink[]) => visibleDegrees(links);

  it("cuenta las aristas visibles de cada nodo, no las del servidor", () => {
    const counted = degrees([link("a", "b"), link("a", "c"), link("b", "c")]);

    expect(counted.get("a")).toBe(2);
    expect(counted.get("b")).toBe(2);
    expect(counted.get("c")).toBe(2);
  });

  it("un nodo sin aristas cuenta cero, no queda fuera", () => {
    expect(degrees([link("a", "b")]).get("solo") ?? 0).toBe(0);
  });

  it("con las mismas aristas, más conexiones es más radio", () => {
    const counted = degrees([link("hub", "a"), link("hub", "b"), link("hub", "c"), link("a", "b")]);
    const sizing = { degrees: counted, maxDegree: 3 };

    const hub = radiusOf(node("hub", "memory", "hub") as Node, 1, sizing);
    const hoja = radiusOf(node("c", "memory", "hoja") as Node, 1, sizing);

    expect(hub).toBeGreaterThan(hoja);
  });

  it("el radio nunca pasa de tres veces el mínimo", () => {
    const counted = new Map([["hub", 50]]);
    const sizing = { degrees: counted, maxDegree: 50 };

    const hub = radiusOf(node("hub", "memory", "hub") as Node, 1, sizing);
    const suelto = radiusOf(node("x", "memory", "x") as Node, 1, { degrees: new Map(), maxDegree: 50 });

    expect(hub / suelto).toBeCloseTo(3, 5);
  });

  it("cambia al cambiar los filtros, porque cuenta lo que se dibuja", () => {
    const conParecido = degrees([link("a", "b"), link("a", "c", "related")]);
    const sinParecido = degrees([link("a", "b")]);

    expect(conParecido.get("a")).toBe(2);
    expect(sinParecido.get("a")).toBe(1);
  });

  it("con el tamaño por saliencia el radio es el de siempre, ajeno a las conexiones", () => {
    const salient = { ...node("a", "memory", "a"), salience: 1 } as Node;
    const flojo = { ...node("b", "memory", "b"), salience: 0 } as Node;

    expect(radiusOf(salient, 1)).toBeGreaterThan(radiusOf(flojo, 1));
    // A trait still outweighs any memory: it is the layer that organizes them.
    expect(radiusOf(node("t", "trait", "t") as Node, 1)).toBeGreaterThan(radiusOf(salient, 1));
  });

  it("el área para pinchar nunca baja de 7 px y crece con el nodo", () => {
    const grande = { degrees: new Map([["hub", 50]]), maxDegree: 50 };

    expect(pointerRadius(node("x", "memory", "x") as Node, 1)).toBe(7);
    expect(pointerRadius(node("hub", "memory", "hub") as Node, 3, grande)).toBeGreaterThan(7);
  });
});

describe("la paleta por tema", () => {
  const topic = (...members: string[]) => ({ members });
  /** The first colour of the shared palette: which one it is does not matter, that it is first does. */
  const SCOPE_COLORS_FIRST = topicPalette([topic("solo")]).get("solo");

  it("pinta a cada miembro con el color de su tema", () => {
    const palette = topicPalette([topic("a", "b"), topic("c")]);

    expect(palette.get("a")).toBe(palette.get("b"));
    expect(palette.get("c")).not.toBe(palette.get("a"));
  });

  it("deja sin color los temas que pasan de la paleta, en vez de repetir colores", () => {
    const many = Array.from({ length: 40 }, (_, i) => topic(`m${i}`));

    const palette = topicPalette(many);
    const used = new Set(palette.values());

    expect(used.size).toBe(palette.size);
    expect(palette.size).toBeLessThan(many.length);
    // Topics arrive sorted by size: the first ones are the ones that get painted.
    expect(palette.has("m0")).toBe(true);
    expect(palette.has("m39")).toBe(false);
  });

  it("gasta los colores en los temas que se dibujan, no en los más grandes del total", () => {
    // The first is huge but off screen; the second is small and on it.
    const fuera = topic(...Array.from({ length: 50 }, (_, i) => `fuera${i}`));
    const dentro = topic("visible1", "visible2");

    const palette = topicPalette([fuera, dentro], new Set(["visible1", "visible2"]));

    expect(palette.get("visible1")).toBe(SCOPE_COLORS_FIRST);
    expect(palette.has("fuera0")).toBe(false);
  });

  it("sin temas devuelve una paleta vacía y no revienta", () => {
    expect(topicPalette([]).size).toBe(0);
  });
});
