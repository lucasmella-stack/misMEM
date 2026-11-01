// @vitest-environment jsdom
// The graph tab is forceMount'd, so its two queries stay active while it is hidden and any write
// in another tab refetched both. They are the two most expensive reads the viewer has.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { createElement, forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "../ui/src/api";

const fakes = vi.hoisted(() => ({
  graph: vi.fn(),
  topics: vi.fn(),
}));

class SizedResizeObserver implements ResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = SizedResizeObserver;

vi.mock("react-force-graph-2d", () => ({
  default: forwardRef(function FakeGraph(_props: unknown, ref) {
    useImperativeHandle(ref, () => ({
      zoomToFit: () => {},
      d3Force: () => undefined,
      d3ReheatSimulation: () => {},
      pauseAnimation: () => {},
      resumeAnimation: () => {},
    }));
    return createElement("div", { "data-testid": "lienzo" });
  }),
}));

vi.mock("../ui/src/api", async (importOriginal) => {
  const real = (await importOriginal()) as { api: Record<string, unknown> };
  return { ...real, api: { ...real.api, graph: fakes.graph, topics: fakes.topics } };
});

const { default: GraphView } = await import("../ui/src/components/GraphView");

const empty: GraphData = {
  nodes: [],
  links: [],
  truncated: { memories: false, traits: false, episodes: false },
};

afterEach(() => {
  cleanup();
  fakes.graph.mockClear();
  fakes.topics.mockClear();
});

function mount(client: QueryClient, active: boolean) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(GraphView, { scope: "s", query: "", active, onSelect: () => {} }),
  );
}

describe("el grafo oculto no se pide", () => {
  it("con la pestaña oculta no pide el grafo, y lo pide al volver", async () => {
    fakes.graph.mockResolvedValue(empty);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { rerender } = render(mount(client, false));
    // /api/graph recomputes a cosine per pair over the drawn memories, so a write in the
    // Memorias tab was paying for a drawing nobody was looking at.
    expect(fakes.graph).not.toHaveBeenCalled();

    rerender(mount(client, true));
    await vi.waitFor(() => expect(fakes.graph).toHaveBeenCalledTimes(1));
  });
});
