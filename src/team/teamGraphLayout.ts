/**
 * GUI-only team graph layout helpers (node positions + edge bezier controls).
 * Ignored by the graph orchestration engine.
 */
import { graphNodeRef } from './teamGraph.js';
import type { TeamDefinition, TeamGraphEdge } from '../types.js';

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphEdgeBezierUi {
  /** Offset from the source port for cubic-bezier control point 1. */
  c1?: { dx: number; dy: number };
  /** Offset from the target port for cubic-bezier control point 2. */
  c2?: { dx: number; dy: number };
}

/** Default S-curve offsets — horizontal or vertical depending on port layout. */
export function defaultEdgeBezierOffsets(p1: GraphPoint, p2: GraphPoint): Required<GraphEdgeBezierUi> {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const bulge = Math.max(56, Math.max(Math.abs(dx), Math.abs(dy)) * 0.4);
  if (Math.abs(dx) > Math.abs(dy) * 0.65) {
    const sx = dx >= 0 ? 1 : -1;
    return { c1: { dx: sx * bulge, dy: dy * 0.12 }, c2: { dx: -sx * bulge, dy: -dy * 0.12 } };
  }
  const sy = dy >= 0 ? 1 : -1;
  return { c1: { dx: dx * 0.12, dy: sy * bulge }, c2: { dx: -dx * 0.12, dy: -sy * bulge } };
}

export function resolveEdgeBezierPoints(
  p1: GraphPoint,
  p2: GraphPoint,
  ui?: GraphEdgeBezierUi | TeamGraphEdge['ui'],
): { c1: GraphPoint; c2: GraphPoint; path: string } {
  const defaults = defaultEdgeBezierOffsets(p1, p2);
  const c1off = ui?.c1 ?? defaults.c1;
  const c2off = ui?.c2 ?? defaults.c2;
  const c1 = { x: p1.x + c1off.dx, y: p1.y + c1off.dy };
  const c2 = { x: p2.x + c2off.dx, y: p2.y + c2off.dy };
  const path = `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
  return { c1, c2, path };
}

export function writeEdgeBezierUi(
  edge: TeamGraphEdge,
  p1: GraphPoint,
  p2: GraphPoint,
  c1: GraphPoint,
  c2: GraphPoint,
): void {
  edge.ui = {
    c1: { dx: c1.x - p1.x, dy: c1.y - p1.y },
    c2: { dx: c2.x - p2.x, dy: c2.y - p2.y },
  };
}

export function clearEdgeBezierUi(edge: TeamGraphEdge): void {
  delete edge.ui;
}

/**
 * Semantic auto-layout rows: Task → member agents → loop leaders → Return.
 * Task fans out to every agent (including synthesizer), so topology layers
 * collapse panel members and the synthesizer into one row — this splits them.
 */
export function computeTeamGraphAutoLayoutLanes(
  def: Pick<TeamDefinition, 'nodes' | 'edges'>,
): number[][] {
  const nodes = def.nodes ?? [];
  const edges = def.edges ?? [];
  const loopSources = new Set(
    edges.filter((e) => e.loop).map((e) => String(e.from).trim()),
  );

  const taskRow: number[] = [];
  const memberRow: number[] = [];
  const leaderRow: number[] = [];
  const returnRow: number[] = [];

  nodes.forEach((node, i) => {
    const kind = node.kind ?? 'agent';
    if (kind === 'task') taskRow.push(i);
    else if (kind === 'return') returnRow.push(i);
    else if (loopSources.has(graphNodeRef(node))) leaderRow.push(i);
    else memberRow.push(i);
  });

  const sortRow = (indices: number[]) =>
    [...indices].sort((a, b) => graphNodeRef(nodes[a]!).localeCompare(graphNodeRef(nodes[b]!)));

  return [taskRow, memberRow, leaderRow, returnRow]
    .map(sortRow)
    .filter((row) => row.length > 0);
}
