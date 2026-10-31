import { describe, expect, it } from "vitest";
import type { GraphData, GraphLink, GraphNode } from "../ui/src/api";
import {
  coUseGlow,
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
  it("una asociación fuerte se dibuja más viva y más gruesa que una débil", () => {
    const fuerte = coUseGlow(0.9);
    const debil = coUseGlow(0.1);

    expect(fuerte.alpha).toBeGreaterThan(debil.alpha);
    expect(fuerte.width).toBeGreaterThan(debil.width);
  });

  it("una fuerza negativa no ilumina: el par se evita, no se asocia", () => {
    // Below zero, NPMI says they show up together less often than chance predicts.
    expect(coUseGlow(-0.5)).toEqual(coUseGlow(0));
  });

  it("sin fuerza se dibuja como la arista más apagada", () => {
    expect(coUseGlow(undefined)).toEqual(coUseGlow(0));
  });

  it("nunca pasa de opaca por mucha fuerza que traiga", () => {
    expect(coUseGlow(1).alpha).toBeLessThanOrEqual(1);
  });
});

describe("halo de un nodo del conectoma", () => {
  it("se normaliza contra el nodo más fuerte a la vista", () => {
    // Unnormalized, a graph of weak associations reads as dark and one of strong associations
    // as burnt: what matters is who stands out among what is drawn.
    expect(hubGlow(2, 2)).toBeCloseTo(1, 5);
    expect(hubGlow(1, 2)).toBeCloseTo(0.5, 5);
  });

  it("sin nadie fuerte a la vista no inventa un halo", () => {
    expect(hubGlow(0, 0)).toBe(0);
    expect(hubGlow(undefined, 5)).toBe(0);
  });

  it("una fuerza negativa acumulada no ilumina", () => {
    expect(hubGlow(-3, 5)).toBe(0);
  });
});

describe("tamaño de muestra", () => {
  it("declara un umbral por debajo del cual la fuerza es ruido", () => {
    // With few turns, two memories used once and together that once score 1: the interface
    // has to be able to say the figure means nothing yet.
    expect(THIN_SAMPLE_TURNS).toBeGreaterThan(1);
  });
});
