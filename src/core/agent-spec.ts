import type { JsonObject, JsonValue } from './json.js';
import type { InputItem } from './items.js';
import type { ModelRef } from './model-ref.js';
import type { RunContext } from './run.js';

export type MaybePromise<T> = T | Promise<T>;

export type PromptSource<TContext> =
  | string
  | ((context: RunContext<TContext>) => MaybePromise<string>);

export type ToolRef =
  | string
  | {
      readonly id: string;
      readonly options?: JsonObject;
    };

export interface HandoffRef<TContext = unknown> {
  readonly id: string;
  readonly targetAgentId: string;
  readonly description?: string;
  readonly filter?: (
    context: RunContext<TContext>,
    input: readonly InputItem[],
  ) => MaybePromise<readonly InputItem[]>;
  readonly metadata?: JsonObject;
}

export interface OutputSchema<TOutput> {
  readonly name: string;
  readonly schema: JsonObject;
  readonly description?: string;
  readonly strict?: boolean;
  readonly parse?: (value: JsonValue) => TOutput;
}

export interface GuardrailDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly metadata?: JsonObject;
}

export interface InputGuardrail<TContext> {
  readonly id: string;
  evaluate(
    context: RunContext<TContext>,
    input: readonly InputItem[],
  ): MaybePromise<GuardrailDecision>;
}

export interface OutputGuardrail<TContext, TOutput> {
  readonly id: string;
  evaluate(
    context: RunContext<TContext>,
    output: TOutput,
  ): MaybePromise<GuardrailDecision>;
}

/** A registry reference; executable middleware is owned by the runtime layer. */
export type MiddlewareRef<TContext = unknown> =
  | string
  | {
      readonly id: string;
      readonly options?: JsonObject;
    };

export interface RunLimits {
  readonly maxTurns: number;
  readonly runDeadlineMs: number;
  readonly modelCallTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly hookTimeoutMs: number;
  readonly maxParallelTools: number;
  readonly maxSubagentDepth: number;
  readonly maxSubagentFanout: number;
  readonly streamBufferSize: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
}

/** Immutable agent configuration. Mutable execution state belongs to AgentRuntime. */
export interface AgentSpec<TContext = unknown, TOutput = string> {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly instructions: PromptSource<TContext>;
  readonly model?: ModelRef;
  readonly tools?: readonly ToolRef[];
  readonly handoffs?: readonly HandoffRef<TContext>[];
  readonly output?: OutputSchema<TOutput>;
  readonly inputGuardrails?: readonly InputGuardrail<TContext>[];
  readonly outputGuardrails?: readonly OutputGuardrail<TContext, TOutput>[];
  readonly middleware?: readonly MiddlewareRef<TContext>[];
  readonly limits?: Partial<RunLimits>;
  readonly metadata?: JsonObject;
}
