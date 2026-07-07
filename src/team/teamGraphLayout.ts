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

const MIN_CONTROL_TENSION = 36;
const DEFAULT_TENSION_MAX = 96;

/** Default S-curve tension — capped so auto curves stay gentle on long edges. */
export function defaultEdgeTension(p1: GraphPoint, p2: GraphPoint): number {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  return Math.min(DEFAULT_TENSION_MAX, Math.max(MIN_CONTROL_TENSION, dist * 0.28));
}

/**
 * Normalize stored offsets: fill missing c1/c2 with defaults and guard against
 * non-finite values. No upper clamp — users can drag control points arbitrarily
 * far. Reset-curve restores defaults; `clearEdgeBezierUiForNodeRef` drops stale
 * offsets when a node moves.
 */
export function sanitizeEdgeBezierUi(
  p1: GraphPoint,
  p2: GraphPoint,
  ui?: GraphEdgeBezierUi | TeamGraphEdge['ui'],
): Required<GraphEdgeBezierUi> | undefined {
  if (!ui?.c1 && !ui?.c2) return undefined;
  const defaults = defaultEdgeBezierOffsets(p1, p2);
  const merge = (
    off: { dx?: number; dy?: number } | undefined,
    def: { dx: number; dy: number },
  ): { dx: number; dy: number } => {
    const dx = off?.dx ?? def.dx;
    const dy = off?.dy ?? def.dy;
    return Number.isFinite(dx) && Number.isFinite(dy) ? { dx, dy } : def;
  };
  return { c1: merge(ui?.c1, defaults.c1), c2: merge(ui?.c2, defaults.c2) };
}

/** Default S-curve — capped tension, follows dominant axis between ports. */
export function defaultEdgeBezierOffsets(p1: GraphPoint, p2: GraphPoint): Required<GraphEdgeBezierUi> {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const tension = defaultEdgeTension(p1, p2);
  if (Math.abs(dy) >= Math.abs(dx) * 0.55) {
    const sy = dy >= 0 ? 1 : -1;
    return { c1: { dx: dx * 0.06, dy: sy * tension }, c2: { dx: -dx * 0.06, dy: -sy * tension } };
  }
  const sx = dx >= 0 ? 1 : -1;
  return { c1: { dx: sx * tension, dy: dy * 0.06 }, c2: { dx: -sx * tension, dy: -dy * 0.06 } };
}

export function resolveEdgeBezierPoints(
  p1: GraphPoint,
  p2: GraphPoint,
  ui?: GraphEdgeBezierUi | TeamGraphEdge['ui'],
): { c1: GraphPoint; c2: GraphPoint; path: string } {
  const offsets = sanitizeEdgeBezierUi(p1, p2, ui) ?? defaultEdgeBezierOffsets(p1, p2);
  const c1 = { x: p1.x + offsets.c1.dx, y: p1.y + offsets.c1.dy };
  const c2 = { x: p2.x + offsets.c2.dx, y: p2.y + offsets.c2.dy };
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

/** Drop custom curves on edges touching a moved node so paths re-default cleanly. */
export function clearEdgeBezierUiForNodeRef(
  def: Pick<TeamDefinition, 'edges'>,
  ref: string,
): void {
  const key = ref.trim();
  if (!key) return;
  for (const edge of def.edges ?? []) {
    if (String(edge.from).trim() === key || String(edge.to).trim() === key) {
      clearEdgeBezierUi(edge);
    }
  }
}

/** Join bezier helpers for injection into the GUI client script bundle. */
export function getTeamGraphBezierClientScript(): string {
  return [
    'const MIN_CONTROL_TENSION = 36;',
    'const DEFAULT_TENSION_MAX = 96;',
    defaultEdgeTension.toString(),
    sanitizeEdgeBezierUi.toString(),
    defaultEdgeBezierOffsets.toString(),
    resolveEdgeBezierPoints.toString(),
    writeEdgeBezierUi.toString(),
    clearEdgeBezierUi.toString(),
    clearEdgeBezierUiForNodeRef.toString(),
  ].join('\n');
}

/**
 * Semantic auto-layout rows: Task → member agents → loop leaders → Return.
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
