import { describe, expect, it } from "vitest";
import { GRAPH_MAX_HUBS } from "../src/queries/graph.js";
import type { GraphData, GraphLink, GraphNode } from "../ui/src/api";
import {
  coUseGlow,
  PANEL_MAX_HUBS,
  supportConfidence,
  filterGraph,
  hubGlow,
  THIN_SAMPLE_TURNS,
  type GraphFilters,
} from "../ui/src/lib/graph";

const node = (id: string, layer: GraphNode["layer"] = "memory"): GraphNode => ({
  id,
  layer,
  scope: "s",
  label: id,
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

const lateral = (source: string, target: string, strength: number, n = 3): GraphLink => ({
  source,
  target,
  kind: "co_use",
  n,
  strength,
});

describe("el conectoma de un nodo se recalcula sobre lo que queda dibujado", () => {
  it("un vecino no conserva la fuerza de aristas que ya no se dibujan", () => {
    // The server measures over everything it sent; the canvas draws a subset. Keeping the
    // server's figure makes a node wear the halo of a hub with a single edge on screen.
    const centro: GraphNode = { ...node("centro"), co_use: { degree: 2, strength: 1.4, support: 9 } };
    const queda: GraphNode = { ...node("queda"), co_use: { degree: 1, strength: 0.7, support: 9 } };
    const sale: GraphNode = { ...node("sale"), co_use: { degree: 1, strength: 0.7, support: 4 } };

    const out = filterGraph(
      data([centro, queda, sale], [lateral("centro", "queda", 0.7, 9), lateral("centro", "sale", 0.7, 4)]),
      filters({ query: "c" }),
    );

    // Only `centro` matches the query, so every lateral edge is gone with its neighbours.
    expect(out.nodes.map((n) => n.id)).toEqual(["centro"]);
    expect(out.nodes[0]?.co_use).toBeUndefined();
  });

  it("conserva el soporte y el grado de las aristas que sí sobreviven", () => {
    const a: GraphNode = { ...node("a"), co_use: { degree: 2, strength: 1.4, support: 9 } };
    const b: GraphNode = { ...node("b"), co_use: { degree: 1, strength: 0.7, support: 9 } };

    const out = filterGraph(data([a, b], [lateral("a", "b", 0.7, 9)]), filters());

    const propio = out.nodes.find((n) => n.id === "a")?.co_use;
    expect(propio?.degree).toBe(1);
    expect(propio?.support).toBe(9);
    // Weighted by support, the same way the server accumulates it.
    expect(propio?.strength).toBeCloseTo(0.7 * (8 / 9), 10);
  });
});

describe("filtro de la capa lateral", () => {
  it("con el conectoma apagado no dibuja las aristas por co-uso", () => {
    const out = filterGraph(data([node("a"), node("b")], [lateral("a", "b", 0.8)]), filters({ coUse: false }));

    expect(out.links).toEqual([]);
  });

  it("con el conectoma encendido las conserva con su fuerza y su soporte", () => {
    const out = filterGraph(data([node("a"), node("b")], [lateral("a", "b", 0.8, 4)]), filters());

    expect(out.links).toHaveLength(1);
    expect(out.links[0]).toMatchObject({ kind: "co_use", n: 4, strength: 0.8 });
  });

  it("apagarlo puede dejar huérfano a un nodo, y sin huérfanas desaparece", () => {
    // A memory that hangs only off co-use: turning the layer off leaves nothing holding it.
    const out = filterGraph(
      data([node("a"), node("b")], [lateral("a", "b", 0.8)]),
      filters({ coUse: false, orphans: false }),
    );

    expect(out.nodes).toEqual([]);
  });
});

describe("iluminación de una arista lateral", () => {
  // Every case below fixes the support, so what it compares is strength and nothing else.
  const SOPORTE = 10;

  it("una asociación fuerte se dibuja más viva y más gruesa que una débil", () => {
    const fuerte = coUseGlow(0.9, SOPORTE);
    const debil = coUseGlow(0.1, SOPORTE);

    expect(fuerte.alpha).toBeGreaterThan(debil.alpha);
    expect(fuerte.width).toBeGreaterThan(debil.width);
  });

  it("una fuerza negativa no ilumina: el par se evita, no se asocia", () => {
    // Below zero, NPMI says they show up together less often than chance predicts.
    expect(coUseGlow(-0.5, SOPORTE)).toEqual(coUseGlow(0, SOPORTE));
  });

  it("sin fuerza se dibuja como la arista más apagada", () => {
    expect(coUseGlow(undefined, SOPORTE)).toEqual(coUseGlow(0, SOPORTE));
  });

  it("nunca pasa de opaca por mucha fuerza y mucho soporte que traiga", () => {
    expect(coUseGlow(1, 1000).alpha).toBeLessThanOrEqual(1);
  });
});

describe("halo de un nodo del conectoma", () => {
  // Support is fixed and high wherever only the normalization is under test.
  const PROBADO = 1000;

  it("se normaliza contra el nodo más fuerte a la vista", () => {
    // Unnormalized, a graph of weak associations reads as dark and one of strong associations
    // as burnt: what matters is who stands out among what is drawn.
    expect(hubGlow(2, 2, PROBADO)).toBeCloseTo(1, 2);
    expect(hubGlow(1, 2, PROBADO)).toBeCloseTo(0.5, 2);
  });

  it("sin nadie fuerte a la vista no inventa un halo", () => {
    expect(hubGlow(0, 0)).toBe(0);
    expect(hubGlow(undefined, 5)).toBe(0);
  });

  it("una fuerza negativa acumulada no ilumina", () => {
    expect(hubGlow(-3, 5)).toBe(0);
  });

  it("un hub cuya única prueba es una coincidencia no se enciende", () => {
    // Its accumulated strength is the maximum in view, but nothing behind it ever repeated.
    expect(hubGlow(1, 1, 1)).toBe(0);
  });

  it("a igual fuerza, el que repitió más brilla más", () => {
    expect(hubGlow(2, 2, 10)).toBeGreaterThan(hubGlow(2, 2, 2));
  });
});

describe("tamaño de muestra", () => {
  it("declara un umbral por debajo del cual la fuerza es ruido", () => {
    // With few turns, two memories used once and together that once score 1: the interface
    // has to be able to say the figure means nothing yet.
    expect(THIN_SAMPLE_TURNS).toBeGreaterThan(1);
  });
});

describe("soporte de un par", () => {
  // NPMI reads 1 both for "always together" and for "once, and that was the only turn either
  // appeared in". Strength alone cannot tell evidence from coincidence, so the drawing has to
  // read the support that already travels with every lateral edge.
  it("un par visto una sola vez no aporta nada en que creer", () => {
    expect(supportConfidence(1)).toBe(0);
    expect(supportConfidence(undefined)).toBe(0);
  });

  it("crece con las repeticiones y nunca llega a la certeza", () => {
    expect(supportConfidence(2)).toBeCloseTo(0.5, 5);
    expect(supportConfidence(4)).toBeCloseTo(0.75, 5);
    expect(supportConfidence(1000)).toBeLessThan(1);
  });

  it("un par visto una vez no puede brillar más que una asociación medida", () => {
    // The real shape of production on 2026-10-31: 37 pairs, every one with n=1 and both ends
    // used once, so every one scores a perfect 1 while a pair backed by eight turns scores 0.40.
    const coincidencia = coUseGlow(1, 1);
    const medida = coUseGlow(0.4, 8);
    expect(coincidencia.alpha).toBeLessThan(medida.alpha);
    expect(coincidencia.width).toBeLessThan(medida.width);
  });

  it("sin soporte cae al suelo del trazo, que es no decir nada", () => {
    // Drawn, but with the same ink as a pair nobody measured: absence of evidence is not a path.
    expect(coUseGlow(1, 1)).toEqual(coUseGlow(0, 99));
  });
});

describe("topes de la lista de hubs", () => {
  it("el servidor manda al menos los que el panel dibuja", () => {
    // Two caps for one list: if the server's drops below the panel's, the list runs short and
    // nothing says so.
    expect(GRAPH_MAX_HUBS).toBeGreaterThanOrEqual(PANEL_MAX_HUBS);
  });
});
