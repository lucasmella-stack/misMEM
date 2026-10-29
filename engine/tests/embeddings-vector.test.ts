import { describe, expect, it } from "vitest";
import { checkedUnitVectors, cosine, unitVector } from "../src/embeddings/vector.js";

describe("unitVector", () => {
  it("devuelve una copia normalizada a norma 1 sin mutar la entrada", () => {
    const input = new Float32Array([3, 4]);
    const checked = unitVector(input);

    expect(checked).not.toBeNull();
    expect(checked?.[0]).toBeCloseTo(0.6);
    expect(checked?.[1]).toBeCloseTo(0.8);
    expect(checked).not.toBe(input);
    expect(Array.from(input)).toEqual([3, 4]);
  });

  it.each([
    { label: "NaN", bad: [Number.NaN, 1] },
    { label: "Infinity", bad: [Number.POSITIVE_INFINITY, 1] },
    { label: "norma cero", bad: [0, 0] },
    { label: "desbordamiento a Float32", bad: [1e39, 1] },
    { label: "null", bad: [1, null, 2] },
    { label: "no numérico", bad: [1, "2", 2] },
  ])("devuelve null si el vector trae $label", ({ bad }) => {
    expect(unitVector(bad as unknown as ArrayLike<number>)).toBeNull();
  });

  it("devuelve null para un vector sin dimensiones", () => {
    expect(unitVector([])).toBeNull();
  });
});

describe("checkedUnitVectors", () => {
  it("normaliza cada vector del lote", () => {
    const checked = checkedUnitVectors([new Float32Array([3, 4]), [0, 2]]);

    expect(checked).toHaveLength(2);
    expect(checked?.[0]?.[0]).toBeCloseTo(0.6);
    expect(checked?.[0]?.[1]).toBeCloseTo(0.8);
    expect(Array.from(checked?.[1] ?? [])).toEqual([0, 1]);
  });

  it("una lista vacía no es un lote válido", () => {
    expect(checkedUnitVectors([])).toBeNull();
  });

  // Rejecting the whole batch used to pin the healthy neighbours as pending forever: the
  // pending order is stable, so they always landed in the same poisoned batch.
  it.each([
    { label: "NaN", bad: [Number.NaN, 1] },
    { label: "Infinity", bad: [Number.POSITIVE_INFINITY, 1] },
    { label: "norma cero", bad: [0, 0] },
    { label: "desbordamiento a Float32", bad: [1e39, 1] },
    { label: "null", bad: [1, null] },
  ])("un vector con $label sólo se pierde a sí mismo", ({ bad }) => {
    const checked = checkedUnitVectors([[1, 0], bad as unknown as number[]]);

    expect(checked).not.toBeNull();
    expect(Array.from(checked?.[0] ?? [])).toEqual([1, 0]);
    expect(checked?.[1]).toBeNull();
  });

  it("rechaza un lote con un vector sin dimensiones", () => {
    expect(checkedUnitVectors([[]])).toBeNull();
  });

  it("rechaza un lote con dimensiones mezcladas entre vectores válidos", () => {
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
