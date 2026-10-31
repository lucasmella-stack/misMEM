import { describe, expect, it } from "vitest";
import { supportConfidence } from "../src/domain/support.js";
import { supportConfidence as supportConfidenceUi } from "../ui/src/lib/graph";

describe("confianza por soporte", () => {
  it("un par visto una sola vez no repite nada y no vale nada", () => {
    expect(supportConfidence(1)).toBe(0);
    expect(supportConfidence(0)).toBe(0);
    expect(supportConfidence(undefined)).toBe(0);
  });

  it("crece con las repeticiones y nunca llega a la certeza", () => {
    expect(supportConfidence(2)).toBeCloseTo(0.5, 10);
    expect(supportConfidence(4)).toBeCloseTo(0.75, 10);
    expect(supportConfidence(1_000_000)).toBeLessThan(1);
  });

  it("el motor y la interfaz pesan el soporte igual", () => {
    // The viewer cannot import from src/, so the rule lives twice. If the two ever disagree,
    // the canvas dims an edge the ranking still trusts, and nothing else would notice.
    for (const n of [undefined, 0, 1, 2, 3, 7, 23, 1000]) {
      expect(supportConfidenceUi(n)).toBe(supportConfidence(n));
    }
  });
});
