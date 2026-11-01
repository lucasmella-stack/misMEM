import { describe, expect, it } from "vitest";
import type { GraphLink } from "../ui/src/api";
import type { Link } from "../ui/src/components/graph/paint";
import { colorOfLink, colorOfNode, nodeWeight, paintNode, widthOfLink } from "../ui/src/components/graph/paint";

/**
 * `tokensNow` reads the CSS variables off the document, and the project has no renderer. The
 * stub gives it the fallbacks it already falls back to, so the colour logic can be tested.
 */
function conDocumento(): void {
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} },
  };
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => "",
  });
}

const link = (over: Partial<GraphLink> = {}): Link =>
  ({ source: "a", target: "b", kind: "co_use", ...over }) as Link;

describe("grosor de una arista", () => {
  it("la que toca al nodo activo manda sobre cualquier otra regla", () => {
    expect(widthOfLink(link({ strength: 0 }), "a")).toBe(1.6);
    expect(widthOfLink(link({ kind: "evidence" }), "b")).toBe(1.6);
  });

  it("una arista por parecido o de evidencia tiene un grosor fijo", () => {
    expect(widthOfLink(link({ kind: "related" }), null)).toBe(0.7);
    expect(widthOfLink(link({ kind: "evidence" }), null)).toBe(0.6);
  });

  it("a igual soporte, más asociación se dibuja más gruesa", () => {
    const fuerte = widthOfLink(link({ n: 10, strength: 0.9 }), null);
    const debil = widthOfLink(link({ n: 10, strength: 0.1 }), null);

    expect(fuerte).toBeGreaterThan(debil);
  });

  it("un par visto una sola vez no se dibuja más grueso que uno medido", () => {
    // The real shape of production on 2026-10-31: every pair with n=1 and both ends used once,
    // which NPMI scores a perfect 1 — against 0.40 for a pair backed by eight turns.
    const coincidencia = widthOfLink(link({ n: 1, strength: 1 }), null);
    const medida = widthOfLink(link({ n: 8, strength: 0.4 }), null);

    expect(coincidencia).toBeLessThan(medida);
  });

  it("sin soporte cae al mismo trazo que una arista por parecido", () => {
    // Drawn, but saying nothing: one sighting is not a path worth following.
    expect(widthOfLink(link({ n: 1, strength: 1 }), null)).toBe(0.7);
  });
});

describe("peso de un nodo", () => {
  it("un rasgo pesa igual siempre, una memoria según su saliencia", () => {
    expect(nodeWeight({ layer: "trait" } as never)).toBe(5);
    expect(nodeWeight({ layer: "memory", salience: 0 } as never)).toBe(1);
    expect(nodeWeight({ layer: "memory", salience: 1 } as never)).toBe(3.5);
  });

  it("sin saliencia asume la mitad en vez de desaparecer", () => {
    expect(nodeWeight({ layer: "memory" } as never)).toBe(nodeWeight({ layer: "memory", salience: 0.5 } as never));
  });
});

describe("color de un nodo", () => {
  it("sin color asignado el nodo se pinta igual, en vez de desaparecer", () => {
    conDocumento();
    const fuera = colorOfNode({ layer: "memory", scope: "sin-color" } as never, () => undefined);
    expect(fuera).toBeTruthy();
  });

  it("un rasgo se pinta con el color de marca, lo diga quien lo diga", () => {
    conDocumento();
    const rasgo = { layer: "trait", id: "t1", scope: "x" } as never;

    // The layer that organizes the rest keeps its colour whichever grouping is painting.
    expect(colorOfNode(rasgo, () => "#000000")).not.toBe("#000000");
    expect(colorOfNode(rasgo, () => undefined)).toBe(colorOfNode(rasgo, () => "#123456"));
  });

  it("toma el color de quien se lo da, sea por ámbito o por tema", () => {
    conDocumento();
    const nodo = { layer: "memory", id: "m1", scope: "x" } as never;
    expect(colorOfNode(nodo, (n) => ({ x: "#abcdef" })[n.scope])).toBe("#abcdef");
    expect(colorOfNode(nodo, (n) => ({ m1: "#123456" })[String(n.id)])).toBe("#123456");
  });
});

describe("color de una arista", () => {
  it("una arista sin soporte se pinta tan apagada como una sin fuerza", () => {
    conDocumento();
    expect(colorOfLink(link({ n: 1, strength: 1 }), null)).toBe(colorOfLink(link({ strength: 0, n: 9 }), null));
  });

  it("una arista que no es de co-uso usa el color del borde, no el de marca", () => {
    conDocumento();
    expect(colorOfLink(link({ kind: "related" }), null)).toBe(colorOfLink(link({ kind: "evidence" }), null));
  });
});

/** The same document stub, but answering per token so one colour can be told from another. */
function conTokens(theme: string, values: Record<string, string>): void {
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: { theme } },
  };
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({
    getPropertyValue: (name: string) => values[name] ?? "",
  });
}

/** A canvas that paints nothing and remembers the colours it was asked for. */
function ctxEspia(): { ctx: CanvasRenderingContext2D; stops: string[] } {
  const stops: string[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "" as string | CanvasGradient,
    strokeStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    lineWidth: 1,
    createRadialGradient: () => ({ addColorStop: (_: number, color: string) => stops.push(color) }),
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    measureText: () => ({ width: 10 }),
    fillText: () => {},
    setLineDash: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, stops };
}

describe("el halo del conectoma", () => {
  const nodo = {
    id: "m1",
    layer: "memory" as const,
    scope: "s",
    label: "una memoria",
    salience: 1,
    co_use: { degree: 2, strength: 0.8, support: 10 },
    x: 0,
    y: 0,
  };
  const paint = {
    nodeSize: 1,
    textThreshold: 99,
    active: null,
    isLit: () => true,
    color: () => "#000000",
    positions: new Map<string, { x: number; y: number }>(),
    maxHubStrength: 0.8,
  };

  // The brand token glows over a dark surface and reads as a dirty ring over a light one, so the
  // halo has its own. Painting it with brand was invisible to every test until this one.
  it("se pinta con --color-graph-halo y no con el token de marca", () => {
    conTokens("probe-halo", { "--color-brand": "#111111", "--color-graph-halo": "#eeeeee" });
    const { ctx, stops } = ctxEspia();

    paintNode(nodo, ctx, 1, paint);

    expect(stops[0]).toBe("#eeeeee");
  });
});
