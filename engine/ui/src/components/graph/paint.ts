import type { LinkObject, NodeObject } from "react-force-graph-2d";
import type { GraphLink, GraphNode } from "../../api";
import { CANVAS_LABEL_CHARS, RELATED_EDGE_WIDTH, coUseGlow, hubGlow } from "../../lib/graph";
import { tokensNow } from "../../lib/graph-tokens";

export type Node = NodeObject<GraphNode>;
export type Link = LinkObject<GraphNode, GraphLink>;

type End = string | number | NodeObject<GraphNode> | undefined;

/** force-graph swaps ids for nodes as soon as it computes: both are accepted here. */
const endId = (end: End): string | undefined => {
  if (end === undefined || end === null) return undefined;
  return typeof end === "object" ? (end.id === undefined ? undefined : String(end.id)) : String(end);
};

/** How many drawn edges each node has, and the most any of them has: 0 turns the mode off. */
export interface Sizing {
  degrees: Map<string, number>;
  maxDegree: number;
}

/**
 * The simulation sizes a node from this and the canvas draws its radius from the same number,
 * so the circle and the force field cannot disagree.
 */
export const nodeWeight = (node: Node, sizing?: Sizing): number => {
  // By connections every layer measures the same way: a trait fixed at 5 and an episode at a
  // salience of 0.5 said nothing about which of them organizes the rest.
  if (sizing && sizing.maxDegree > 0) {
    const share = Math.min(1, (sizing.degrees.get(String(node.id)) ?? 0) / sizing.maxDegree);
    return MEMORY_MIN_WEIGHT + DEGREE_WEIGHT_RANGE * share;
  }
  return node.layer === "trait"
    ? TRAIT_WEIGHT
    : MEMORY_MIN_WEIGHT + MEMORY_WEIGHT_RANGE * (node.salience ?? UNKNOWN_SALIENCE);
};

/**
 * A trait outweighs every memory because it is the layer that organizes them, and a memory of
 * unknown salience sits mid-scale rather than vanishing. Weight becomes pixels through a square
 * root so a node four times as salient reads twice as wide, not four times.
 */
const TRAIT_WEIGHT = 5;
const MEMORY_MIN_WEIGHT = 1;
const MEMORY_WEIGHT_RANGE = 2.5;
// Pixels come out of a square root, so 9x the weight is 3x the radius: the most connected node
// reads as a centre without swallowing its neighbours.
const DEGREE_WEIGHT_RANGE = 8;
const UNKNOWN_SALIENCE = 0.5;
const WEIGHT_TO_PIXELS = 2.2;

/** Outside the lit set the graph keeps a trace of context instead of going black. */
const DIMMED_ALPHA = 0.15;

/** The halo grows from just outside the circle and never swallows its neighbours. */
const HALO_MIN_SCALE = 1.8;
const HALO_GROWTH = 1.4;
const HALO_MAX_ALPHA = 0.5;

export const radiusOf = (node: Node, size: number, sizing?: Sizing): number =>
  Math.sqrt(nodeWeight(node, sizing) * size) * WEIGHT_TO_PIXELS;

/** The area that takes a click: never under the minimum, and it grows with a bigger node. */
export const pointerRadius = (node: Node, size: number, sizing?: Sizing): number =>
  Math.max(POINTER_MIN_RADIUS, radiusOf(node, size, sizing));

const POINTER_MIN_RADIUS = 7;

/** The disc force-graph hit-tests against: the same radius the node is drawn with, never smaller. */
export function paintPointerArea(
  node: Node,
  color: string,
  ctx: CanvasRenderingContext2D,
  size: number,
  sizing?: Sizing,
): void {
  if (node.x == null || node.y == null) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, pointerRadius(node, size, sizing), 0, 2 * Math.PI);
  ctx.fill();
}

/**
 * The caller decides what the colour means — scope or topic — because a topic is keyed by memory
 * and a scope by name. A trait keeps the brand colour: it is the layer that organizes the rest.
 */
export function colorOfNode(node: Node, color: (node: Node) => string | undefined): string {
  if (node.layer === "trait") return tokensNow().brand;
  return color(node) ?? tokensNow().inkMuted;
}

interface NodePaint {
  nodeSize: number;
  textThreshold: number;
  selectedId?: string;
  active: string | null;
  isLit: (id: string) => boolean;
  color: (node: Node) => string;
  positions: Map<string, { x: number; y: number }>;
  /** Strongest accumulated association in view; 0 turns the halos off. */
  maxHubStrength: number;
  /** Absent, the radius comes from salience, which is the drawing of before. */
  sizing?: Sizing;
}

/** Draws one node; every piece of state it needs arrives in `paint`, never through a closure. */
export function paintNode(node: Node, ctx: CanvasRenderingContext2D, scale: number, paint: NodePaint): void {
  if (node.x == null || node.y == null) return;
  const tokens = tokensNow();
  const id = String(node.id);
  const saved = paint.positions.get(id);
  if (saved?.x !== node.x || saved.y !== node.y) paint.positions.set(id, { x: node.x, y: node.y });
  const lit = paint.isLit(id);
  const radius = radiusOf(node, paint.nodeSize, paint.sizing);

  // Outside the active node and its neighbours the graph dims: focus reads at a glance.
  ctx.globalAlpha = lit ? 1 : DIMMED_ALPHA;

  // The halo is the whole point of the connectome view: a node that orients others glows,
  // and it is drawn under the circle so it never hides the colour of its scope.
  const glow = hubGlow(node.co_use?.strength, paint.maxHubStrength, node.co_use?.support);
  if (glow > 0 && lit) {
    const halo = radius * (HALO_MIN_SCALE + HALO_GROWTH * glow);
    const gradient = ctx.createRadialGradient(node.x, node.y, radius, node.x, node.y, halo);
    gradient.addColorStop(0, tokens.graphHalo);
    gradient.addColorStop(1, "transparent");
    ctx.globalAlpha = HALO_MAX_ALPHA * glow;
    ctx.beginPath();
    ctx.arc(node.x, node.y, halo, 0, 2 * Math.PI);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = paint.color(node);
  ctx.fill();

  if (id === paint.selectedId) {
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = tokens.ink;
    ctx.stroke();
  }

  const focused = paint.active !== null && lit;
  if (scale > paint.textThreshold || focused) {
    const fontSize = 11 / scale;
    const text = node.label.length > CANVAS_LABEL_CHARS
      ? `${node.label.slice(0, CANVAS_LABEL_CHARS - 1)}…`
      : node.label;
    // On hover a neighbour's label reads regardless of the zoom.
    ctx.globalAlpha *= Math.min(1, scale - paint.textThreshold + (focused ? 1 : 0.4));
    ctx.font = `${fontSize}px "JetBrains Mono Variable", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = tokens.inkSoft;
    ctx.fillText(text, node.x, node.y + radius + 2 / scale);
  }

  ctx.globalAlpha = 1;
}

export function colorOfLink(link: Link, active: string | null): string {
  const tokens = tokensNow();
  const touching = active !== null && (endId(link.source) === active || endId(link.target) === active);
  if (touching) return tokens.brand;
  // A measured path is the one worth following, so it keeps its colour when nothing is hovered
  // and fades with its own strength instead of with the rest of the drawing.
  if (link.kind === "co_use") return withAlpha(tokens.brand, coUseGlow(link.strength, link.n).alpha);
  return tokens.edge;
}

export function widthOfLink(link: Link, active: string | null): number {
  const touching = active !== null && (endId(link.source) === active || endId(link.target) === active);
  if (touching) return 1.6;
  if (link.kind === "co_use") return coUseGlow(link.strength, link.n).width;
  return link.kind === "related" ? RELATED_EDGE_WIDTH : 0.6;
}

/** The token may arrive as #rgb, #rrggbb or a colour function: only the first two can be mixed. */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!hex) return color;
  const digits = hex[1] as string;
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;
  const value = Number.parseInt(full, 16);
  return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`;
}
