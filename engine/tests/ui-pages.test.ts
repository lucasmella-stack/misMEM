import { describe, expect, it } from "vitest";
import { mergePages, nextPageOffset, pagesLostRows } from "../ui/src/lib/pages";

const row = (id: string): { id: string; text: string } => ({ id, text: `texto de ${id}` });

describe("mergePages", () => {
  it("quita los ids repetidos entre páginas y conserva el primer orden", () => {
    const merged = mergePages([
      [row("a"), row("b"), row("c")],
      [row("c"), row("d"), row("e")],
    ]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("conserva la primera aparición de una fila repetida", () => {
    const first = row("a");
    const merged = mergePages([[first], [row("b"), { ...first, text: "copia desplazada" }]]);
    expect(merged[0]).toBe(first);
  });

  it("con una sola página no toca el orden", () => {
    expect(mergePages([[row("b"), row("a")]]).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("sin páginas devuelve una lista vacía", () => {
    expect(mergePages([])).toEqual([]);
  });
});

describe("pagesLostRows", () => {
  it("no avisa de pérdida cuando las páginas no repiten filas", () => {
    expect(
      pagesLostRows([
        [row("a"), row("b"), row("c")],
        [row("d"), row("e")],
      ]),
    ).toBe(false);
  });

  it("avisa de pérdida cuando una fila repetida desplaza el resto", () => {
    expect(
      pagesLostRows([
        [row("a"), row("b"), row("c")],
        [row("c"), row("d")],
      ]),
    ).toBe(true);
  });

  it("con una sola página nunca hay pérdida", () => {
    expect(pagesLostRows([[row("a"), row("b")]])).toBe(false);
  });
});

describe("nextPageOffset", () => {
  it("pide la página siguiente mientras queden filas detrás", () => {
    expect(nextPageOffset(0, 50, 51)).toBe(50);
  });

  it("avanza por las filas que llegaron, no por el tamaño de página", () => {
    expect(nextPageOffset(0, 10, 100)).toBe(10);
  });

  it("se detiene al alcanzar el total aunque la página viniera casi vacía", () => {
    expect(nextPageOffset(50, 1, 51)).toBeUndefined();
  });

  it("no pide otra página cuando la última ya trajo todo el total", () => {
    expect(nextPageOffset(0, 50, 50)).toBeUndefined();
  });
});
