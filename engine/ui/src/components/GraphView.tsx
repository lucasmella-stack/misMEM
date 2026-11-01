import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { forceX, forceY, type ForceLink, type ForceManyBody } from "d3-force";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { api, type GraphLink, type GraphNode, type Layer } from "../api";
import { errorMessage } from "../lib/errors";
import { escapeHtml, filterGraph, neighborsOf, scopePalette, type GraphFilters } from "../lib/graph";
import { DEFAULT_SETTINGS, GraphPanel, type GraphSettings } from "./GraphPanel";
import { ConnectomePanel } from "./graph/ConnectomePanel";
import { colorOfLink, colorOfNode, nodeWeight, paintNode, type Link, type Node, widthOfLink } from "./graph/paint";

interface Props {
  scope: string | undefined;
  query: string;
  selectedId?: string;
  /** The tab is on screen: otherwise the animation pauses even though the graph stays mounted. */
  active: boolean;
  onSelect: (layer: Layer, id: string) => void;
}

const EMPTY = { nodes: [] as GraphNode[], links: [] as GraphLink[], truncated: { memories: false, traits: false, episodes: false } };

export default function GraphView({ scope, query, selectedId, active: visible, onSelect }: Props) {
  const [settings, setSettings] = useState<GraphSettings>(DEFAULT_SETTINGS);
  const [hovered, setHovered] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const fitted = useRef(false);
  const positions = useRef(new Map<string, { x: number; y: number }>());

  // Switching scope never shows the previous scope's graph: it is only kept while the same
  // scope reloads (for example, when episodes are turned on).
  const graphQuery = useQuery({
    queryKey: ["graph", scope ?? "", settings.episodes, settings.related, settings.coUse, settings.coUseMinN],
    queryFn: ({ signal }) =>
      api.graph(scope, settings.episodes, settings.related, { enabled: settings.coUse, minN: settings.coUseMinN }, signal),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (scope ?? "") ? previous : undefined,
  });
  const data = graphQuery.data;

  // The local graph's centre only matters when the mode is on: that way selecting with the
  // mode off neither rebuilds the data nor wakes the simulation.
  const centerId = settings.localEnabled ? selectedId : undefined;

  const filters = useMemo<GraphFilters>(
    () => ({
      traits: settings.traits,
      orphans: settings.orphans,
      related: settings.related,
      episodes: settings.episodes,
      coUse: settings.coUse,
      query,
      local: { enabled: settings.localEnabled, depth: settings.depth, centerId },
    }),
    [
      settings.traits,
      settings.orphans,
      settings.related,
      settings.episodes,
      settings.coUse,
      settings.localEnabled,
      settings.depth,
      query,
      centerId,
    ],
  );

  const graphData = useMemo(() => {
    const filtered = data ? filterGraph(data, filters) : EMPTY;
    // force-graph receives copies and lays them out from scratch: each gets its last position
    // back so filtering or selecting does not restart the drawing under a camera that stays put.
    for (const node of filtered.nodes) {
      const saved = positions.current.get(node.id);
      if (saved) {
        const placed = node as GraphNode & { x?: number; y?: number };
        placed.x = saved.x;
        placed.y = saved.y;
      }
    }
    return filtered;
  }, [data, filters]);

  const scopes = useMemo(() => data?.nodes.map((node) => node.scope) ?? [], [data]);
  const palette = useMemo(() => scopePalette(scopes), [scopes]);

  // The halo is normalized against what is drawn, so it is measured over the filtered graph and
  // not over everything the server sent.
  const maxHubStrength = useMemo(
    () => graphData.nodes.reduce((top, node) => Math.max(top, node.co_use?.strength ?? 0), 0),
    [graphData.nodes],
  );
  const drawnIds = useMemo(() => new Set(graphData.nodes.map((node) => node.id)), [graphData.nodes]);
  const labels = useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.id, node.label])),
    [data],
  );

  // An episode has no detail of its own: it opens the memory it was consolidated into.
  const origins = useMemo(() => {
    const map = new Map<string, string>();
    for (const link of data?.links ?? []) if (link.kind === "origin") map.set(link.source, link.target);
    return map;
  }, [data]);

  const active = hovered ?? selectedId ?? null;
  const neighbors = useMemo(
    () => (active ? neighborsOf(graphData.links, active) : new Set<string>()),
    [active, graphData.links],
  );
  const isLit = useCallback(
    (id: string) => active === null || id === active || neighbors.has(id),
    [active, neighbors],
  );

  const changeSettings = useCallback(
    (patch: Partial<GraphSettings>) => setSettings((previous) => ({ ...previous, ...patch })),
    [],
  );

  const nodeVal = useCallback((node: Node) => nodeWeight(node) * settings.nodeSize, [settings.nodeSize]);

  const nodeColor = useCallback(
    (node: Node) => colorOfNode(node, palette, settings.colorByScope),
    [palette, settings.colorByScope],
  );

  const nodeCanvasObject = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, scale: number) =>
      paintNode(node, ctx, scale, {
        nodeSize: settings.nodeSize,
        textThreshold: settings.textThreshold,
        selectedId,
        active,
        isLit,
        color: nodeColor,
        positions: positions.current,
        maxHubStrength,
      }),
    [active, isLit, maxHubStrength, nodeColor, selectedId, settings.nodeSize, settings.textThreshold],
  );

  const linkColor = useCallback((link: Link) => colorOfLink(link, active), [active]);

  const linkWidth = useCallback((link: Link) => widthOfLink(link, active), [active]);

  const onNodeHover = useCallback((node: Node | null) => setHovered(node ? String(node.id) : null), []);

  const onNodeClick = useCallback(
    (node: Node) => {
      const id = String(node.id);
      if (node.layer === "episode") {
        const memory = origins.get(id);
        if (memory) onSelect("memory", memory);
        return;
      }
      onSelect(node.layer, id);
    },
    [onSelect, origins],
  );

  const onEngineStop = useCallback(() => {
    if (fitted.current || graphData.nodes.length === 0) return;
    fitted.current = true;
    graphRef.current?.zoomToFit(500, 40);
  }, [graphData.nodes.length]);

  // Forces from the mock-up: gravity to the centre, repulsion, link and distance adjustable.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const charge = graph.d3Force("charge") as ForceManyBody<Node> | undefined;
    charge?.strength(-settings.repulsion);
    const link = graph.d3Force("link") as ForceLink<Node, GraphLink> | undefined;
    link?.distance(settings.distance).strength((edge) => settings.link * (edge.kind === "related" ? 0.5 : 1));
    graph.d3Force("x", forceX<Node>(0).strength(settings.center));
    graph.d3Force("y", forceY<Node>(0).strength(settings.center));
    graph.d3ReheatSimulation();
  }, [settings.center, settings.repulsion, settings.link, settings.distance, size.width]);

  // The container sets the size, not the window: the graph lives inside a tab.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      // The inactive tab is hidden with display:none and would measure zero: accepting that
      // would unmount the canvas and lose camera and simulation on return.
      if (width === 0 || height === 0) return;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Hidden it stays mounted but must not burn CPU: the animation pauses and resumes on return,
  // restarting neither the simulation nor the camera. `size.width` reapplies the state when the
  // canvas finishes mounting after the first effect.
  useEffect(() => {
    if (visible) graphRef.current?.resumeAnimation();
    else graphRef.current?.pauseAnimation();
  }, [visible, size.width]);

  // force-graph mutates the nodes and adds x/y; this ref grants access to those coordinates.
  const positioned = graphData.nodes as Array<GraphNode & { x?: number; y?: number }>;
  const nodesRef = useRef(positioned);
  nodesRef.current = positioned;

  // Selecting from outside (list or detail) moves the camera to the node, without touching zoom.
  useEffect(() => {
    if (!selectedId) return;
    let attempts = 0;
    let timer = 0;
    const focus = () => {
      const node = nodesRef.current.find((entry) => entry.id === selectedId);
      if (node?.x != null && node.y != null) {
        graphRef.current?.centerAt(node.x, node.y, 600);
        return;
      }
      if (attempts++ < 20) timer = window.setTimeout(focus, 100);
    };
    focus();
    return () => window.clearTimeout(timer);
  }, [selectedId, size.width]);

  const truncated: string[] = [];
  if (data?.truncated.memories) truncated.push("memorias");
  if (data?.truncated.traits) truncated.push("rasgos");
  if (data?.truncated.episodes) truncated.push("episodios");

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[360px] w-full overflow-hidden rounded-lg border border-edge bg-surface"
    >
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          nodeId="id"
          backgroundColor="rgba(0,0,0,0)"
          autoPauseRedraw={false}
          cooldownTicks={200}
          nodeVal={nodeVal}
          nodeColor={nodeColor}
          nodeLabel={(node) => escapeHtml(node.label)}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={(node, color, ctx) => {
            if (node.x == null || node.y == null) return;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, 7, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={(link) => (link.kind === "related" ? [2, 2] : null)}
          // At the tip of the edge; length 0 leaves the line clean when they are off.
          linkDirectionalArrowLength={settings.arrows ? 3 : 0}
          linkDirectionalArrowRelPos={1}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
          onEngineStop={onEngineStop}
        />
      )}

      <GraphPanel settings={settings} onChange={changeSettings} scopes={scopes} width={size.width} />

      {settings.coUse && data?.connectome && (
        <ConnectomePanel
          summary={data.connectome}
          labels={labels}
          maxHubStrength={maxHubStrength}
          drawn={drawnIds}
          onSelect={(id) => onSelect("memory", id)}
        />
      )}

      {data === undefined && graphQuery.isPending && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="text-sm text-ink-muted">Cargando el grafo…</p>
        </div>
      )}

      {data !== undefined && graphData.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
          <p className="max-w-sm text-center text-sm text-ink-muted">
            {data.nodes.length === 0
              ? "Este ámbito no tiene nada que dibujar todavía: ni memorias, ni rasgos, ni episodios."
              : "Ningún nodo pasa los filtros. Enciende una capa o borra la búsqueda."}
          </p>
        </div>
      )}

      {truncated.length > 0 && (
        <p className="absolute right-3 bottom-3 left-3 rounded-md border border-edge bg-surface-raised/95 px-3 py-1.5 text-xs text-ink-muted sm:left-auto sm:max-w-sm">
          Recortado por el servidor en {truncated.join(", ")}: se dibujan las filas con más saliencia.
        </p>
      )}

      {graphQuery.isError && (
        <p
          role="alert"
          className="absolute right-3 bottom-3 left-3 rounded-md border border-edge bg-surface-raised/95 px-3 py-1.5 text-xs text-danger sm:left-auto sm:max-w-sm"
        >
          No se pudo cargar el grafo: {errorMessage(graphQuery.error)}
        </p>
      )}
    </div>
  );
}
