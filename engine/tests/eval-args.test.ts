import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { jsonPayload, modeLine, parseEvalArgs } from "../src/eval-args.js";

describe("parseEvalArgs", () => {
  it("sin argumentos usa los defaults", () => {
    expect(parseEvalArgs([])).toEqual({ limit: 5, mode: "auto", json: false, help: false });
  });

  it("lee los flags conocidos", () => {
    expect(
      parseEvalArgs(["--dir", "otro/dir", "--limit", "3", "--mode", "semantico", "--json"]),
    ).toEqual({
      dir: "otro/dir",
      limit: 3,
      mode: "semantico",
      json: true,
      help: false,
    });
    expect(parseEvalArgs(["-h"]).help).toBe(true);
  });

  it("un flag mal escrito corta: --jsn dejaba la salida en texto", () => {
    expect(() => parseEvalArgs(["--jsn"])).toThrow(ArgsError);
    expect(() => parseEvalArgs(["eval/golden"])).toThrow(/argumento desconocido: eval\/golden/);
  });

  it("un valor ausente corta", () => {
    expect(() => parseEvalArgs(["--dir"])).toThrow(/--dir necesita un valor/);
    expect(() => parseEvalArgs(["--mode"])).toThrow(/--mode necesita un valor/);
    expect(() => parseEvalArgs(["--limit"])).toThrow(/--limit necesita un valor/);
  });

  it("un limit inválido corta en vez de caer a 5", () => {
    expect(() => parseEvalArgs(["--limit", "abc"])).toThrow(/no es un número/);
    expect(() => parseEvalArgs(["--limit", "0"])).toThrow(/>= 1/);
  });

  it("un limit por encima del máximo de recall es un error de uso, no un fallo de Zod", () => {
    expect(parseEvalArgs(["--limit", "50"]).limit).toBe(50);
    expect(() => parseEvalArgs(["--limit", "51"])).toThrow(/<= 50/);
    expect(() => parseEvalArgs(["--limit", "1e2"])).toThrow(/<= 50/);
  });

  it("un modo desconocido corta en vez de caer a auto", () => {
    expect(() => parseEvalArgs(["--mode", "hibrido"])).toThrow(ArgsError);
    expect(() => parseEvalArgs(["--mode", "hibrido"])).toThrow(/lexico, semantico, auto/);
  });
});

describe("modeLine", () => {
  it("no inventa embeddings en un léxico limpio", () => {
    expect(modeLine({ mode: "lexico", embedded: 0, failed: 0 })).toBe("modo: léxico (sin embeddings)");
  });

  it("dice los contadores cuando el embedder sólo respondió en parte", () => {
    expect(modeLine({ mode: "lexico", embedded: 12, failed: 3 })).toBe(
      "modo: léxico (embeddings incompletos: 12 memorias embebidas, 3 fallidas)",
    );
  });

  it("mantiene la línea semántica con sus fallidas", () => {
    expect(modeLine({ mode: "semantico", embedded: 64, failed: 0 })).toBe(
      "modo: semántico (64 memorias embebidas)",
    );
    expect(modeLine({ mode: "semantico", embedded: 64, failed: 2 })).toBe(
      "modo: semántico (64 memorias embebidas, 2 fallidas)",
    );
  });
});

describe("jsonPayload", () => {
  const report = { global: { questions: 432 } };

  it("omite los contadores a cero", () => {
    expect(jsonPayload({ mode: "lexico", embedded: 0, failed: 0 }, report)).toEqual({
      mode: "lexico",
      global: { questions: 432 },
    });
  });

  it("incluye embedded y failed cuando el modo degradado tiene algo que explicar", () => {
    expect(jsonPayload({ mode: "lexico", embedded: 12, failed: 3 }, report)).toEqual({
      mode: "lexico",
      embedded: 12,
      failed: 3,
      global: { questions: 432 },
    });
  });
});
