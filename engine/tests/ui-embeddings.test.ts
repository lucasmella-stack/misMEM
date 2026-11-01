import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EmbeddingStatus, MemoryDetail } from "../ui/src/api";
import { EmbeddingNoticeView } from "../ui/src/components/EmbeddingNoticeView";
import { MemoryFacts } from "../ui/src/components/MemoryFacts";
import { exact } from "../ui/src/format";
import { embeddingSummary, embeddingWarning, activeModelDims, vectorIsCurrent } from "../ui/src/lib/embeddings";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function status(overrides: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
  return {
    enabled: true,
    model: "embeddinggemma-2",
    memories: 10,
    embedded: 10,
    missing: 0,
    compatible: 10,
    stale_model: 0,
    outdated: 0,
    stale_dims: 0,
    invalid: 0,
    active_dims: null,
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

  it("no avisa si nunca se indexó: el servidor de embeddings es opcional", () => {
    expect(embeddingWarning(status({ embedded: 0, missing: 10, compatible: 0 }))).toBeNull();
  });

  it("avisa de los vectores del modelo activo con otras dimensiones y manda --force", () => {
    const message = embeddingWarning(status({ stale_dims: 2, compatible: 8 }));

    expect(message).toContain("2 memorias con vectores de otras dimensiones");
    expect(message).toContain("mismem-embed --force");
  });

  it("avisa del vector que ya no coincide con su texto", () => {
    const message = embeddingWarning(status({ outdated: 2 }));
    expect(message).toContain("2 memorias con un vector que ya no coincide con su texto");
    expect(message).toContain("mismem-embed");
    expect(message).not.toContain("--force");
  });

  it("no arma un aviso vacío si el servidor deja de mandar un contador", () => {
    const sinContador = status({ stale_dims: undefined as unknown as number });
    expect(embeddingWarning(sinContador)).toBeNull();
  });

  it("no manda --force cuando el problema es sólo otro modelo", () => {
    const message = embeddingWarning(status({ stale_model: 2, compatible: 8 }));

    expect(message).toContain("mismem-embed");
    expect(message).not.toContain("--force");
  });
});

describe("vectorIsCurrent", () => {
  it("da por vigente el vector con el modelo activo y su ancho", () => {
    expect(vectorIsCurrent({ model: "embeddinggemma-2", dims: 768 }, "embeddinggemma-2", 768)).toBe(true);
  });

  it("marca obsoleto el vector del modelo activo con otro ancho: la búsqueda no lo lee", () => {
    expect(vectorIsCurrent({ model: "embeddinggemma-2", dims: 512 }, "embeddinggemma-2", 768)).toBe(false);
  });

  it("marca obsoleto el vector de otro modelo aunque coincida el ancho", () => {
    expect(vectorIsCurrent({ model: "viejo", dims: 768 }, "embeddinggemma-2", 768)).toBe(false);
  });
});

describe("activeModelDims", () => {
  it("toma el ancho que el servidor marca como activo, no la mayoría de los vectores", () => {
    const dims = activeModelDims(
      status({
        active_dims: 768,
        models: [
          { model: "embeddinggemma-2", dims: 512, count: 8 },
          { model: "embeddinggemma-2", dims: 768, count: 2 },
        ],
      }),
    );

    expect(dims).toBe(768);
  });

  it("sin ancho activo en el estado no deduce uno: confía en lo que dice el servidor", () => {
    expect(activeModelDims(status({ active_dims: null, models: [] }))).toBeUndefined();
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

  it("marca como obsoleto el vector de un modelo distinto del activo", () => {
    const summary = embeddingSummary(
      { model: "viejo", dims: 3, created_at: NOW },
      NOW,
      "nuevo",
    );

    expect(summary).toContain("obsoleto: no lo usa la búsqueda");
  });

  it("no marca el vector del modelo activo", () => {
    const summary = embeddingSummary(
      { model: "nuevo", dims: 3, created_at: NOW },
      NOW,
      "nuevo",
    );

    expect(summary).not.toContain("obsoleto");
  });

  it("marca como obsoleto el vector del modelo activo con otro ancho", () => {
    const summary = embeddingSummary(
      { model: "nuevo", dims: 3, created_at: NOW },
      NOW,
      "nuevo",
      4,
    );

    expect(summary).toContain("obsoleto: no lo usa la búsqueda");
  });
});

function memory(overrides: Partial<MemoryDetail["memory"]> = {}): MemoryDetail["memory"] {
  return {
    id: "mem_1",
    scope: "vida",
    text: "una memoria",
    details: null,
    salience: 0.5,
    stored_salience: 0.5,
    use_count: 3,
    created_at: NOW,
    last_accessed_at: null,
    noise: false,
    embedding: null,
    ...overrides,
  };
}

describe("EmbeddingNoticeView", () => {
  it("deja montada la región viva aunque no haya aviso", () => {
    const html = renderToStaticMarkup(createElement(EmbeddingNoticeView, { message: null }));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("El índice semántico");
  });

  it("anuncia el aviso cuando lo hay", () => {
    const html = renderToStaticMarkup(
      createElement(EmbeddingNoticeView, { message: "El índice semántico no está al día." }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("El índice semántico no está al día.");
  });
});

describe("MemoryFacts", () => {
  it("enseña los usos y el vector con su modelo y dimensiones", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryFacts, {
        memory: memory({
          use_count: 7,
          embedding: { model: "embeddinggemma-2", dims: 768, created_at: NOW },
        }),
        activeModel: "embeddinggemma-2",
      }),
    );

    expect(html).toContain("Usos");
    expect(html).toContain(">7<");
    expect(html).toContain("Vector");
    expect(html).toContain("embeddinggemma-2");
    expect(html).toContain("768 dimensiones");
    expect(html).not.toContain("obsoleto");
  });

  it("sin vector lo dice con todas las letras", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryFacts, { memory: memory(), activeModel: "embeddinggemma-2" }),
    );

    expect(html).toContain("Sin vector: no aparece en la búsqueda por significado");
  });

  it("marca como obsoleto el vector de otro modelo", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryFacts, {
        memory: memory({ embedding: { model: "viejo", dims: 3, created_at: NOW } }),
        activeModel: "nuevo",
      }),
    );

    expect(html).toContain("obsoleto: no lo usa la búsqueda");
  });

  it("marca como obsoleto el vector del modelo activo con otras dimensiones", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryFacts, {
        memory: memory({ embedding: { model: "embeddinggemma-2", dims: 512, created_at: NOW } }),
        activeModel: "embeddinggemma-2",
        activeDims: 768,
      }),
    );

    expect(html).toContain("obsoleto: no lo usa la búsqueda");
  });

  it("con el ancho activo del servidor separa el vector vigente del de otro ancho", () => {
    const active = status({ active_dims: 768 });
    const render = (dims: number): string =>
      renderToStaticMarkup(
        createElement(MemoryFacts, {
          memory: memory({ embedding: { model: "embeddinggemma-2", dims, created_at: NOW } }),
          activeModel: active.model,
          activeDims: activeModelDims(active),
        }),
      );

    expect(render(512)).toContain("obsoleto: no lo usa la búsqueda");
    expect(render(768)).not.toContain("obsoleto");
  });

  it("junto a la fecha relativa enseña la absoluta de una fecha fija", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryFacts, {
        memory: memory({ created_at: NOW, last_accessed_at: NOW }),
        activeModel: "embeddinggemma-2",
      }),
    );

    expect(html).toContain(exact(NOW));
  });
});
