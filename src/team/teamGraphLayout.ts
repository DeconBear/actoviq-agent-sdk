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
  // Spread the existing ui so fromPort/toPort (snap-point selection) survive a
  // control-point drag — otherwise the endpoint would snap back to center.
  edge.ui = {
    ...edge.ui,
    c1: { dx: c1.x - p1.x, dy: c1.y - p1.y },
    c2: { dx: c2.x - p2.x, dy: c2.y - p2.y },
  };
}

export function clearEdgeBezierUi(edge: TeamGraphEdge): void {
  // Only drop the bezier shape; keep fromPort/toPort so a "reset curve" or
  // auto-layout doesn't also reset the user's snap-point selection.
  if (!edge.ui) return;
  delete edge.ui.c1;
  delete edge.ui.c2;
  if (edge.ui.fromPort == null && edge.ui.toPort == null) delete edge.ui;
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

export type GraphSide = 'n' | 'e' | 's' | 'w';

export interface GraphRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Anchor point on a node rect for a given side + snap index. */
export function sideAnchor(
  rect: GraphRect,
  side: GraphSide,
  portIndex = 1,
  portCount = 3,
): GraphPoint {
  const count = Math.max(1, portCount);
  const idx = Math.min(Math.max(0, portIndex), count - 1);
  const t = count <= 1 ? 0.5 : (idx + 1) / (count + 1);
  switch (side) {
    case 'n':
      return { x: rect.x + rect.w * t, y: rect.y };
    case 's':
      return { x: rect.x + rect.w * t, y: rect.y + rect.h };
    case 'w':
      return { x: rect.x, y: rect.y + rect.h * t };
    case 'e':
      return { x: rect.x + rect.w, y: rect.y + rect.h * t };
  }
}

/**
 * Pick the nearest (fromSide, toSide, fromPort, toPort) by Euclidean distance.
 * When fromPort/toPort are omitted, searches every snap index on each side.
 */
export function pickShortestSides(
  fromRect: GraphRect,
  toRect: GraphRect,
  opts?: {
    fromSides?: GraphSide[];
    toSides?: GraphSide[];
    fromPort?: number;
    toPort?: number;
    fromPortCount?: number;
    toPortCount?: number;
  },
): { fromSide: GraphSide; toSide: GraphSide; fromPort: number; toPort: number } {
  const fromSides = opts?.fromSides ?? (['n', 'e', 's', 'w'] as GraphSide[]);
  const toSides = opts?.toSides ?? (['n', 'e', 's', 'w'] as GraphSide[]);
  const fromPortCount = Math.max(1, opts?.fromPortCount ?? 3);
  const toPortCount = Math.max(1, opts?.toPortCount ?? 3);
  const fromPorts = opts?.fromPort != null
    ? [Math.min(Math.max(0, opts.fromPort), fromPortCount - 1)]
    : Array.from({ length: fromPortCount }, (_, i) => i);
  const toPorts = opts?.toPort != null
    ? [Math.min(Math.max(0, opts.toPort), toPortCount - 1)]
    : Array.from({ length: toPortCount }, (_, i) => i);
  let best: { fromSide: GraphSide; toSide: GraphSide; fromPort: number; toPort: number } | null = null;
  let bestDist = Infinity;
  for (const fs of fromSides) {
    for (const ts of toSides) {
      for (const fp of fromPorts) {
        for (const tp of toPorts) {
          const a = sideAnchor(fromRect, fs, fp, fromPortCount);
          const b = sideAnchor(toRect, ts, tp, toPortCount);
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d < bestDist) {
            bestDist = d;
            best = { fromSide: fs, toSide: ts, fromPort: fp, toPort: tp };
          }
        }
      }
    }
  }
  return best ?? {
    fromSide: 's',
    toSide: 'n',
    fromPort: Math.floor(fromPortCount / 2),
    toPort: Math.floor(toPortCount / 2),
  };
}

/**
 * True when the straight chord between ports cuts through a node card interior.
 * Used to heal locked/stale sides that leave a ghost curve over the node body.
 */
export function edgeChordCrossesNodeInterior(
  p1: GraphPoint,
  p2: GraphPoint,
  fromRect: GraphRect,
  toRect: GraphRect,
  inset = 10,
): boolean {
  const shrink = (r: GraphRect): GraphRect => {
    if (r.w <= inset * 2 || r.h <= inset * 2) return r;
    return { x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 };
  };
  const crosses = (r: GraphRect): boolean => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    let enter = 0;
    let exit = 1;
    for (const [origin, delta, min, max] of [
      [p1.x, dx, r.x, r.x + r.w],
      [p1.y, dy, r.y, r.y + r.h],
    ] as const) {
      if (delta === 0) {
        if (origin < min || origin > max) return false;
        continue;
      }
      const a = (min - origin) / delta;
      const b = (max - origin) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return false;
    }
    return exit > 0 && enter < 1;
  };
  return crosses(shrink(fromRect)) || crosses(shrink(toRect));
}

/** Migrate legacy top-in/bottom-out ports to sides (does not set sideLocked). */
export function migrateLegacyEdgeSides(edge: TeamGraphEdge): void {
  if (edge.ui?.fromSide && edge.ui?.toSide) return;
  edge.ui = {
    ...edge.ui,
    fromSide: edge.ui?.fromSide ?? 's',
    toSide: edge.ui?.toSide ?? 'n',
  };
}

/** Axis-aligned bounds of member nodes for a visual uiGroup (GUI-only). */
export function computeGroupBounds(
  nodes: Array<{ ui?: { x?: number; y?: number }; kind?: string }>,
  memberRefs: string[],
  refOf: (n: { ui?: { x?: number; y?: number }; kind?: string }, i: number) => string,
  sizeOf: (n: { kind?: string }) => { w: number; h: number },
): GraphRect | null {
  const set = new Set(memberRefs.map((r) => r.trim()).filter(Boolean));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  nodes.forEach((n, i) => {
    const ref = refOf(n, i);
    if (!set.has(ref) || n.ui?.x == null || n.ui?.y == null) return;
    const { w, h } = sizeOf(n);
    minX = Math.min(minX, n.ui.x);
    minY = Math.min(minY, n.ui.y);
    maxX = Math.max(maxX, n.ui.x + w);
    maxY = Math.max(maxY, n.ui.y + h);
  });
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Join bezier + smart-side helpers for injection into the GUI client script bundle. */
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
    sideAnchor.toString(),
    pickShortestSides.toString(),
    edgeChordCrossesNodeInterior.toString(),
    migrateLegacyEdgeSides.toString(),
    computeGroupBounds.toString(),
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
