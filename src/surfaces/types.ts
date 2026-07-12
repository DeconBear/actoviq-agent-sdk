import type { TraceContext } from '../events/runEvents.js';

export const SURFACE_TARGETS = ['cli', 'tui', 'gui', 'bridge'] as const;

export type SurfaceTarget = (typeof SURFACE_TARGETS)[number];

export type SurfaceSemanticCategory =
  | 'run'
  | 'request'
  | 'model'
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'compaction'
  | 'interruption'
  | 'error'
  | 'terminal'
  | 'usage'
  | 'extension';

export type SurfaceSemanticType =
  | 'run.started'
  | 'run.resumed'
  | 'request.started'
  | 'request.completed'
  | 'model.completed'
  | 'model.fallback'
  | 'model.content'
  | 'text.delta'
  | 'reasoning.delta'
  | 'tool.input.delta'
  | 'tool.started'
  | 'tool.permission'
  | 'tool.progress'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.rejected'
  | 'compaction.completed'
  | 'interruption.requested'
  | 'interruption.cancelled'
  | 'error'
  | 'terminal'
  | 'usage'
  | 'extension';

/**
 * Stable, product-neutral event consumed by terminal, GUI, and bridge
 * renderers. `sequence` is the source RunEvent sequence; `projectionIndex`
 * differentiates the rare source event that projects to more than one
 * semantic event (for example a failed run projects to error + terminal).
 */
export interface SurfaceSemanticEvent extends TraceContext {
  readonly semanticVersion: 1;
  readonly semanticId: string;
  readonly sourceEventId: string;
  readonly sourceType: string;
  readonly projectionIndex: number;
  readonly sequence: number;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly timestamp: string;
  readonly type: SurfaceSemanticType;
  readonly category: SurfaceSemanticCategory;
  readonly phase: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * One projection is copied for every product surface. The copies prevent a
 * renderer from mutating the event observed by another renderer.
 */
export interface SharedSurfaceProjection {
  readonly semantics: readonly SurfaceSemanticEvent[];
  readonly cli: readonly SurfaceSemanticEvent[];
  readonly tui: readonly SurfaceSemanticEvent[];
  readonly gui: readonly SurfaceSemanticEvent[];
  readonly bridge: readonly SurfaceSemanticEvent[];
}
