import { describe, it, expect } from "vitest";
import { fitPrompt } from "../src/consolidation/budget.js";

const episode = (n: number, body: string) => ({
  id: `01EPISODE0000000000000000${n}`,
  body,
  created_at: 1_700_000_000_000 + n,
});

const budget = (overrides: Partial<Parameters<typeof fitPrompt>[1]> = {}) => ({
  maxEpisodes: Number.POSITIVE_INFINITY,
  maxPromptChars: 60_000,
  maxEpisodeChars: 12_000,
  ...overrides,
});

describe("fitPrompt", () => {
  it("para cuando el siguiente episodio ya no entra en el presupuesto", () => {
    const episodes = [episode(1, "a".repeat(100)), episode(2, "b".repeat(100)), episode(3, "c".repeat(100))];

    // 100 chars of body plus 60 of per-episode overhead: the third no longer fits in 400.
    const fitted = fitPrompt(episodes, budget({ maxPromptChars: 400 }));

    expect(fitted.map((e) => e.id)).toEqual([episodes[0]?.id, episodes[1]?.id]);
  });

  it("el primero entra aunque no quepa: un episodio solo tiene que poder viajar", () => {
    const fitted = fitPrompt([episode(1, "x".repeat(500))], budget({ maxPromptChars: 10 }));

    expect(fitted).toHaveLength(1);
  });

  it("respeta el tope de episodios de la tanda", () => {
    const episodes = [episode(1, "uno"), episode(2, "dos"), episode(3, "tres")];
    const fitted = fitPrompt(episodes, budget({ maxEpisodes: 2 }));

    expect(fitted.map((e) => e.id)).toEqual([episodes[0]?.id, episodes[1]?.id]);
  });

  it("recorta el cuerpo al tope de cada episodio", () => {
    const fitted = fitPrompt([episode(1, "a".repeat(50) + "z".repeat(50))], budget({ maxEpisodeChars: 40 }));

    expect(fitted[0]?.body.length).toBeLessThanOrEqual(40);
    expect(fitted[0]?.body.endsWith("z")).toBe(true);
  });

  it("un episodio que deja el presupuesto justo entra: el borde es inclusivo", () => {
    const episodes = [episode(1, "a".repeat(100)), episode(2, "b".repeat(100))];

    // 100 of body plus 60 of per-episode overhead each: the second one lands exactly on 320.
    const fitted = fitPrompt(episodes, budget({ maxPromptChars: 320 }));

    expect(fitted.map((e) => e.id)).toEqual([episodes[0]?.id, episodes[1]?.id]);
  });

  it("con un carácter menos de presupuesto el segundo episodio ya no entra", () => {
    const episodes = [episode(1, "a".repeat(100)), episode(2, "b".repeat(100))];

    const fitted = fitPrompt(episodes, budget({ maxPromptChars: 319 }));

    expect(fitted.map((e) => e.id)).toEqual([episodes[0]?.id]);
  });

  it("una lista vacía devuelve una lista vacía", () => {
    expect(fitPrompt([], budget())).toEqual([]);
  });
});
