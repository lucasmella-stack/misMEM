import { describe, expect, it } from "vitest";
import type { EmbeddingStatus } from "../ui/src/api";
import { exact } from "../ui/src/format";
import { embeddingSummary, embeddingWarning } from "../ui/src/lib/embeddings";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function status(overrides: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
  return {
    enabled: true,
    provider: "ollama",
    model: "embeddinggemma-2",
    memories: 10,
    embedded: 10,
    missing: 0,
    compatible: 10,
    stale_model: 0,
    models: [],
    ...overrides,
  };
}

describe("embeddingWarning", () => {
  it("no avisa si el índice está apagado", () => {
    expect(embeddingWarning(status({ enabled: false, missing: 4 }))).toBeNull();
  });

  it("no avisa si el índice está sano", () => {
    expect(embeddingWarning(status())).toBeNull();
  });

  it("avisa de las memorias sin vector y de cómo arreglarlo", () => {
    const message = embeddingWarning(status({ missing: 3, embedded: 7, compatible: 7 }));
    expect(message).toContain("3 memorias sin vector");
    expect(message).toContain("mismem-embed");
  });

  it("avisa de los vectores de otro modelo con su cifra", () => {
    const message = embeddingWarning(status({ stale_model: 2, compatible: 8 }));
    expect(message).toContain("2 memorias con vectores de otro modelo");
    expect(message).toContain("mismem-embed");
  });

  it("cuando fallan las dos cosas, enseña las dos cifras", () => {
    const message = embeddingWarning(status({ missing: 1, stale_model: 2, embedded: 9, compatible: 8 }));
    expect(message).toContain("1 memoria sin vector");
    expect(message).toContain("2 memorias con vectores de otro modelo");
  });
});

describe("embeddingSummary", () => {
  it("sin vector lo dice con todas las letras", () => {
    expect(embeddingSummary(null)).toBe("Sin vector: no aparece en la búsqueda por significado");
  });

  it("con vector enseña modelo, dimensiones y la fecha relativa junto a la absoluta", () => {
    const created = NOW - 3 * DAY;
    const summary = embeddingSummary(
      { model: "embeddinggemma-2", dims: 768, created_at: created },
      NOW,
    );
    expect(summary).toContain("embeddinggemma-2");
    expect(summary).toContain("768 dimensiones");
    expect(summary).toContain("hace 3 días");
    expect(summary).toContain(exact(created));
  });
});
