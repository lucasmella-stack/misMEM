import { describe, expect, it } from "vitest";
import type { GraphLink } from "../ui/src/api";
import type { Link } from "../ui/src/components/graph/paint";
import { widthOfLink } from "../ui/src/components/graph/paint";

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
