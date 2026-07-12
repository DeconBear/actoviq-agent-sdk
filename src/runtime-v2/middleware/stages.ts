/**
 * Runtime extension points in their fixed lifecycle order.
 *
 * The string values are part of the inspectable contract. Keep lifecycle
 * ordering in {@link MIDDLEWARE_STAGE_ORDER}; enum declaration order is not
 * used as an implicit sort key.
 */
export enum MiddlewareStage {
  PrepareInput = 'prepareInput',
  BeforeRun = 'beforeRun',
  WrapModelCall = 'wrapModelCall',
  AfterModelResponse = 'afterModelResponse',
  BeforeToolCall = 'beforeToolCall',
  WrapToolCall = 'wrapToolCall',
  AfterToolCall = 'afterToolCall',
  BeforeHandoff = 'beforeHandoff',
  AfterTurn = 'afterTurn',
  FinalizeOutput = 'finalizeOutput',
  AfterRun = 'afterRun',
  OnError = 'onError',
}

export const MIDDLEWARE_STAGE_ORDER = Object.freeze([
  MiddlewareStage.PrepareInput,
  MiddlewareStage.BeforeRun,
  MiddlewareStage.WrapModelCall,
  MiddlewareStage.AfterModelResponse,
  MiddlewareStage.BeforeToolCall,
  MiddlewareStage.WrapToolCall,
  MiddlewareStage.AfterToolCall,
  MiddlewareStage.BeforeHandoff,
  MiddlewareStage.AfterTurn,
  MiddlewareStage.FinalizeOutput,
  MiddlewareStage.AfterRun,
  MiddlewareStage.OnError,
] as const);

const MIDDLEWARE_STAGE_INDEX = new Map<MiddlewareStage, number>(
  MIDDLEWARE_STAGE_ORDER.map((stage, index) => [stage, index]),
);

export function isMiddlewareStage(value: unknown): value is MiddlewareStage {
  return typeof value === 'string' && MIDDLEWARE_STAGE_INDEX.has(value as MiddlewareStage);
}

export function middlewareStageIndex(stage: MiddlewareStage): number {
  const index = MIDDLEWARE_STAGE_INDEX.get(stage);
  if (index === undefined) {
    throw new TypeError(`Unknown middleware stage: ${String(stage)}.`);
  }
  return index;
}
