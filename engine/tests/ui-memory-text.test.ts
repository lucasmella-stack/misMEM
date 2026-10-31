import { describe, expect, it } from "vitest";
import { forgetText, unconsolidateText } from "../ui/src/lib/memory-text";

describe("unconsolidateText", () => {
  it("sin episodios atados no promete una vuelta que no existe", () => {
    expect(unconsolidateText(0)).toBe("La memoria desaparece; no tenía episodios atados.");
  });

  it("con un solo episodio lo nombra en singular", () => {
    expect(unconsolidateText(1)).toBe(
      "La memoria desaparece y su episodio vuelve a estar sin consolidar. La próxima consolidación lo leerá de nuevo.",
    );
  });

  it("con varios episodios los cuenta y usa el plural", () => {
    expect(unconsolidateText(3)).toBe(
      "La memoria desaparece y sus 3 episodios vuelven a estar sin consolidar. La próxima consolidación los leerá de nuevo.",
    );
  });
});

describe("forgetText", () => {
  it("sin episodios ni rasgos que la citen", () => {
    expect(forgetText(0, 0)).toBe("Se borra la memoria. No se puede deshacer.");
  });

  it("con un episodio y sin rasgos", () => {
    expect(forgetText(1, 0)).toBe("Se borran la memoria y su episodio. No se puede deshacer.");
  });

  it("con varios episodios y un rasgo que la cita", () => {
    expect(forgetText(2, 1)).toBe(
      "Se borran la memoria y sus 2 episodios. No se puede deshacer. Un rasgo la cita y seguirá existiendo sin ella.",
    );
  });

  it("con varios rasgos los cuenta", () => {
    expect(forgetText(0, 4)).toBe(
      "Se borra la memoria. No se puede deshacer. 4 rasgos la citan y seguirán existiendo sin ella.",
    );
  });
});
