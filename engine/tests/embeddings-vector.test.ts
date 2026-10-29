import { describe, expect, it } from "vitest";
import { checkedUnitVectors, cosine } from "../src/embeddings/vector.js";

describe("checkedUnitVectors", () => {
  it("devuelve copias normalizadas a norma 1", () => {
    const input = new Float32Array([3, 4]);
    const checked = checkedUnitVectors([input]);

    expect(checked).not.toBeNull();
    expect(checked?.[0]?.[0]).toBeCloseTo(0.6);
    expect(checked?.[0]?.[1]).toBeCloseTo(0.8);
    // Copia: el vector que llega del servidor no se muta.
    expect(checked?.[0]).not.toBe(input);
    expect(Array.from(input)).toEqual([3, 4]);
  });

  it("una lista vacía no es un lote válido", () => {
    expect(checkedUnitVectors([])).toBeNull();
  });

  it.each([
    { label: "NaN", bad: [Number.NaN, 1] },
    { label: "Infinity", bad: [Number.POSITIVE_INFINITY, 1] },
    { label: "norma cero", bad: [0, 0] },
    { label: "desbordamiento a Float32", bad: [1e39, 1] },
  ])("rechaza el lote entero si un vector trae $label", ({ bad }) => {
    expect(checkedUnitVectors([[1, 0], bad])).toBeNull();
  });

  it("rechaza un vector sin dimensiones", () => {
    expect(checkedUnitVectors([[]])).toBeNull();
  });

  it("rechaza un lote con dimensiones mezcladas", () => {
    expect(checkedUnitVectors([[1, 0], [1, 0, 0]])).toBeNull();
  });
});

describe("cosine", () => {
  it("devuelve -1 en vez de NaN cuando el resultado no es finito", () => {
    expect(cosine(new Float32Array([Number.NaN, 1]), new Float32Array([1, 1]))).toBe(-1);
    expect(cosine(new Float32Array([Number.POSITIVE_INFINITY, 1]), new Float32Array([1, 1]))).toBe(
      -1,
    );
  });
});
