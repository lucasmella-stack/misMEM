// @vitest-environment jsdom
// The camera only frames the drawing once per mount, and the tab never unmounts: whether a new
// scope gets its own framing is a decision no pure function holds.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "../ui/src/api";

const spies = vi.hoisted(() => ({
  zoomToFit: vi.fn(),
  stop: undefined as (() => void) | undefined,
}));

// jsdom measures every box as zero and the canvas only mounts with a size, so the observer
// reports one; force-graph itself is replaced because it needs a real canvas.
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
  default: forwardRef(function FakeGraph(props: { onEngineStop?: () => void }, ref) {
    useImperativeHandle(ref, () => ({
      zoomToFit: spies.zoomToFit,
      d3Force: () => undefined,
      d3ReheatSimulation: () => {},
      pauseAnimation: () => {},
      resumeAnimation: () => {},
    }));
    spies.stop = props.onEngineStop;
    return createElement("div", { "data-testid": "lienzo" });
  }),
}));

const { default: GraphView } = await import("../ui/src/components/GraphView");
const { DEFAULT_SETTINGS } = await import("../ui/src/components/GraphPanel");

afterEach(() => {
  cleanup();
  spies.zoomToFit.mockClear();
});

const key = (scope: string) => [
  "graph",
  scope,
  DEFAULT_SETTINGS.episodes,
  DEFAULT_SETTINGS.related,
  DEFAULT_SETTINGS.coUse,
  DEFAULT_SETTINGS.coUseMinN,
];

const graph = (id: string): GraphData => ({
  nodes: [{ id, layer: "memory", scope: "s", label: `memoria ${id}`, salience: 1 }],
  links: [],
  truncated: { memories: false, traits: false, episodes: false },
});

function mount(client: QueryClient, scope: string) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(GraphView, { scope, query: "", active: true, onSelect: () => {} }),
  );
}

describe("el encuadre de la cámara", () => {
  it("vuelve a encuadrar al cambiar de ámbito", () => {
    const client = new QueryClient();
    client.setQueryData(key("a"), graph("m1"));
    client.setQueryData(key("b"), graph("m2"));

    const { rerender } = render(mount(client, "a"));
    act(() => spies.stop?.());
    expect(spies.zoomToFit).toHaveBeenCalledTimes(1);

    // Going from a scope of 400 nodes to one of 3 left the camera on the old framing, and the
    // component is forceMount'd, so it never unmounts to fix itself.
    rerender(mount(client, "b"));
    act(() => spies.stop?.());
    expect(spies.zoomToFit).toHaveBeenCalledTimes(2);
  });

  it("no reencuadra dos veces dentro del mismo ámbito", () => {
    const client = new QueryClient();
    client.setQueryData(key("a"), graph("m1"));

    render(mount(client, "a"));
    act(() => spies.stop?.());
    act(() => spies.stop?.());

    expect(spies.zoomToFit).toHaveBeenCalledTimes(1);
  });
});
