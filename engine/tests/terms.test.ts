import { describe, expect, it } from "vitest";
import { searchTerms } from "../src/terms.js";

describe("palabras de la consulta estricta", () => {
  it("quita las vacías y conserva la que da el tema", () => {
    expect(searchTerms("la de antes")).toEqual(["antes"]);
    expect(searchTerms("¿y ahora qué?")).toEqual(["ahora"]);
  });

  it("cuando todas son vacías, no reinyecta las cortas", () => {
    // "dime sobre el" leaves no term under the recall stopword list. Returning the whole
    // query forces the strict AND to match "el", which no record has on its own; keeping
    // only the long words searches by the one thing that can still tell records apart.
    expect(searchTerms("dime sobre el")).toEqual(["dime", "sobre"]);
  });

  it("si ninguna es lo bastante larga, la consulta va como vino", () => {
    expect(searchTerms("la de")).toEqual(["la", "de"]);
  });
});
