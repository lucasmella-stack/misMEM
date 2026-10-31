import { describe, it, expect } from "vitest";
import { ArgsError } from "../src/cli-args.js";
import { parseConsolidateArgs } from "../src/consolidate-args.js";

describe("parseConsolidateArgs", () => {
  it("sin argumentos deja los defaults a runConsolidation", () => {
    expect(parseConsolidateArgs([])).toEqual({ dryRun: false, help: false });
  });

  it("lee los flags conocidos", () => {
    expect(
      parseConsolidateArgs([
        "--dry-run",
        "--scope",
        "daimon",
        "--min-age-hours",
        "0",
        "--min-episodes",
        "2",
        "--quiet-days",
        "7",
        "--max-batch",
        "20",
        "--uncited-strikes",
        "2",
      ]),
    ).toEqual({
      dryRun: true,
      help: false,
      scope: "daimon",
      minAgeHours: 0,
      minEpisodes: 2,
      quietDays: 7,
      maxBatch: 20,
      uncitedStrikes: 2,
    });
  });

  it("un flag mal escrito corta: --dryrun hacía una corrida pagada", () => {
    expect(() => parseConsolidateArgs(["--dryrun"])).toThrow(ArgsError);
  });

  it("--scope sin valor corta: consolidaba todos los ámbitos", () => {
    expect(() => parseConsolidateArgs(["--scope"])).toThrow(/--scope necesita un valor/);
    expect(() => parseConsolidateArgs(["--scope", "--dry-run"])).toThrow(/--scope necesita un valor/);
    // A blank scope counts too: it filters nothing and silently consolidated every scope.
    expect(() => parseConsolidateArgs(["--scope", ""])).toThrow(/--scope necesita un valor/);
  });

  it("un número inválido corta: NaN dejaba la corrida muda con exit 0", () => {
    expect(() => parseConsolidateArgs(["--min-age-hours"])).toThrow(ArgsError);
    expect(() => parseConsolidateArgs(["--min-age-hours", "abc"])).toThrow(/no es un número/);
  });

  it("fuera de rango corta: LIMIT 0, LIMIT negativo y strikes en 0", () => {
    expect(() => parseConsolidateArgs(["--max-batch", "0"])).toThrow(/>= 1/);
    expect(() => parseConsolidateArgs(["--max-batch", "-2"])).toThrow(/>= 1/);
    expect(() => parseConsolidateArgs(["--max-batch", "2.5"])).toThrow(/entero/);
    expect(() => parseConsolidateArgs(["--uncited-strikes", "0"])).toThrow(/>= 1/);
    expect(() => parseConsolidateArgs(["--min-age-hours", "-1"])).toThrow(/>= 0/);
  });
});
