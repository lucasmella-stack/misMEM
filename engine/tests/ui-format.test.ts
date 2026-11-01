import { describe, expect, it } from "vitest";
import { ago, exact, percent, when } from "../ui/src/format";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

/** Relative dates are the useful information; the exact one goes in `title`. */
describe("ago", () => {
  it("con now fijo, hace 3 días da 'hace 3 días'", () => {
    expect(ago(NOW - 3 * DAY, NOW)).toBe("hace 3 días");
  });

  it("sin fecha conocida da 'nunca'", () => {
    expect(ago(null, NOW)).toBe("nunca");
    expect(ago(undefined, NOW)).toBe("nunca");
  });

  it("lo que acaba de pasar da 'ahora'", () => {
    expect(ago(NOW - 1_000, NOW)).toBe("ahora");
  });
});

describe("exact", () => {
  it("devuelve una fecha legible en castellano", () => {
    const value = exact(NOW);
    expect(value).toContain("2026");
    expect(value.length).toBeGreaterThan(0);
  });
});

describe("when", () => {
  it("junta la fecha relativa con la absoluta entre paréntesis", () => {
    const ts = NOW - 3 * DAY;
    const value = when(ts, NOW);

    expect(value).toContain("hace 3 días");
    expect(value).toContain(exact(ts));
    expect(value.endsWith(`(${exact(ts)})`)).toBe(true);
  });

  it("sin fecha conocida da 'nunca'", () => {
    expect(when(null, NOW)).toBe("nunca");
    expect(when(undefined, NOW)).toBe("nunca");
  });
});

describe("percent", () => {
  it("redondea la fracción y añade la unidad", () => {
    expect(percent(0.426)).toBe("43 %");
    expect(percent(1)).toBe("100 %");
  });
});
