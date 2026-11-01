import { describe, expect, it } from "vitest";
import type { GraphLink } from "../ui/src/api";
import type { Link } from "../ui/src/components/graph/paint";
import { colorOfLink, colorOfNode, nodeWeight, widthOfLink } from "../ui/src/components/graph/paint";

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
  it("un ámbito sin color en la paleta no deja al nodo sin pintar", () => {
    conDocumento();
    const fuera = colorOfNode({ layer: "memory", scope: "sin-color" } as never, new Map(), true);
    expect(fuera).toBeTruthy();
    expect(fuera).toBe(colorOfNode({ layer: "memory", scope: "x" } as never, new Map([["x", "#abc"]]), false));
  });

  it("con color por ámbito apagado ignora la paleta", () => {
    conDocumento();
    const paleta = new Map([["x", "#abcdef"]]);
    expect(colorOfNode({ layer: "memory", scope: "x" } as never, paleta, false)).not.toBe("#abcdef");
    expect(colorOfNode({ layer: "memory", scope: "x" } as never, paleta, true)).toBe("#abcdef");
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
