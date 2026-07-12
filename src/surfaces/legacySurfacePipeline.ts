import type { AgentEvent } from '../types.js';
import {
  LegacyAgentEventRunEventAdapter,
  type LegacyAgentEventAdapterOptions,
} from './legacyEventAdapter.js';
import {
  SharedRunEventSurfaceProjector,
  fanOutSurfaceSemantics,
  type RunEventSemanticProjectorOptions,
} from './runEventProjector.js';
import type { SharedSurfaceProjection, SurfaceSemanticEvent, SurfaceTarget } from './types.js';

export interface LegacySurfaceEventPipelineOptions {
  readonly legacy?: LegacyAgentEventAdapterOptions;
  readonly projector?: RunEventSemanticProjectorOptions;
}
/** Product-surface migration path: AgentEvent -> RunEvent -> shared semantics. */
export class LegacySurfaceEventPipeline {
  readonly legacyAdapter: LegacyAgentEventRunEventAdapter;
  readonly projector: SharedRunEventSurfaceProjector;

  constructor(options: LegacySurfaceEventPipelineOptions = {}) {
    this.legacyAdapter = new LegacyAgentEventRunEventAdapter(options.legacy);
    this.projector = new SharedRunEventSurfaceProjector(options.projector);
  }

  project(event: AgentEvent): SharedSurfaceProjection {
    const runEvent = this.legacyAdapter.adapt(event);
    return runEvent
      ? this.projector.project(runEvent)
      : fanOutSurfaceSemantics([]);
  }

  projectFor(event: AgentEvent, target: SurfaceTarget): readonly SurfaceSemanticEvent[] {
    return this.project(event)[target];
  }

  reset(): void {
    this.legacyAdapter.reset();
    this.projector.reset();
  }
}
