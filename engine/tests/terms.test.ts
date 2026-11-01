import { describe, expect, it } from "vitest";
import { isRescueStopword, searchTerms } from "../src/domain/terms.js";

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

describe("palabras que sólo el rescate descarta", () => {
  it("cubre el presente entero de los verbos que ya estaban a medias", () => {
    // Half a paradigm is worse than none: a question like "¿qué puedo hacer?" kept a verb as
    // if it named the topic and still demanded two matches.
    for (const word of [
      "puedo", "puedes", "podemos", "podéis", "pueden",
      "hago", "haces", "hacemos", "hacéis", "hacen",
      "tengo", "tienes", "tenemos", "tenéis", "tienen",
      "quiero", "quieres", "quiere", "queremos", "queréis", "quieren",
      "sabemos", "sabéis", "saben",
    ]) {
      expect(isRescueStopword(word), word).toBe(true);
    }
  });

  it("no toca las palabras que pueden dar el tema", () => {
    expect(isRescueStopword("despliegue")).toBe(false);
    expect(isRescueStopword("kubernetes")).toBe(false);
  });
});
