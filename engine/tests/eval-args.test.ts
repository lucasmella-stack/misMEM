import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseEvalArgs } from "../src/eval-args.js";

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

  it("un modo desconocido corta en vez de caer a auto", () => {
    expect(() => parseEvalArgs(["--mode", "hibrido"])).toThrow(ArgsError);
    expect(() => parseEvalArgs(["--mode", "hibrido"])).toThrow(/lexico, semantico, auto/);
  });
});
