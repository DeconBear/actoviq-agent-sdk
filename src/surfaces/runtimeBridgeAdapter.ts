import type { AgentSpec, RunResult } from '../core/index.js';
import {
  type AgentInput,
  AgentRuntime,
  type RunHandle,
  type RunOptions,
  type SerializedRunState,
} from '../runtime-v2/index.js';
import {
  SharedRunEventSurfaceProjector,
  type RunEventSemanticProjectorOptions,
} from './runEventProjector.js';
import type { SurfaceSemanticEvent } from './types.js';

export interface AgentRuntimeBridgeAdapterOptions<TContext, TOutput> {
  /** Runtime ownership remains with the caller; the adapter never closes it. */
  readonly runtime: AgentRuntime;
  readonly agent: AgentSpec<TContext, TOutput>;
  readonly projector?: RunEventSemanticProjectorOptions;
}

export interface RuntimeBridgeRunHandle<TOutput = string>
  extends AsyncIterable<SurfaceSemanticEvent> {
  readonly runId: string;
  readonly result: Promise<RunResult<TOutput>>;
  cancel(reason?: string): void;
  snapshot(): Promise<SerializedRunState>;
}

/**
 * Thin product adapter over an existing AgentRuntime. It adds only the stable
 * Bridge event projection and deliberately owns no provider, runtime, service,
 * session, or lifecycle state.
 */
export class AgentRuntimeBridgeAdapter<TContext = unknown, TOutput = string> {
  readonly runtime: AgentRuntime;
  readonly agent: AgentSpec<TContext, TOutput>;
  private readonly projectorOptions: RunEventSemanticProjectorOptions;

  constructor(options: AgentRuntimeBridgeAdapterOptions<TContext, TOutput>) {
    this.runtime = options.runtime;
    this.agent = options.agent;
    this.projectorOptions = options.projector ?? {};
  }

  run(
    input: AgentInput,
    options: RunOptions<TContext> = {},
  ): Promise<RunResult<TOutput>> {
    return this.runtime.run(this.agent, input, options);
  }

  stream(
    input: AgentInput,
    options: RunOptions<TContext> = {},
  ): RuntimeBridgeRunHandle<TOutput> {
    const source = this.runtime.stream(this.agent, input, options);
    return bridgeHandle(source, this.projectorOptions);
  }
}

function bridgeHandle<TOutput>(
  source: RunHandle<TOutput>,
  projectorOptions: RunEventSemanticProjectorOptions,
): RuntimeBridgeRunHandle<TOutput> {
  const projector = new SharedRunEventSurfaceProjector(projectorOptions);
  return {
    runId: source.runId,
    result: source.result,
    cancel: reason => source.cancel(reason),
    snapshot: () => source.snapshot(),
    async *[Symbol.asyncIterator](): AsyncGenerator<SurfaceSemanticEvent> {
      for await (const event of source) {
        yield* projector.project(event).bridge;
      }
    },
  };
}
