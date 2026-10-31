import { describe, expect, it } from "vitest";
import { inkPercent } from "../ui/src/lib/ink";

/**
 * Ink is the project's only visual licence: salience decides how close text gets to
 * `ink`, but never below `ink-muted`, the floor that passes AA. The floor lives in
 * the CSS; here only the scale is pinned.
 */
describe("inkPercent", () => {
  it("lleva los extremos de 0..1 a 0..100", () => {
    expect(inkPercent(0)).toBe(0);
    expect(inkPercent(1)).toBe(100);
  });

  it("recorta lo que se sale del rango", () => {
    expect(inkPercent(1.7)).toBe(100);
    expect(inkPercent(-1)).toBe(0);
  });

  it("redondea para que color-mix reciba un porcentaje entero", () => {
    expect(inkPercent(0.426)).toBe(43);
  });
});
