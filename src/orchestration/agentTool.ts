import {
  assertJsonValue,
  type AgentSpec,
  type JsonObject,
  type JsonValue,
  type ToolResultItem,
} from '../core/index.js';
import type {
  RuntimeTool,
  ToolBehavior,
  ToolExecutionContext,
  ToolOutput,
  ToolSchema,
} from '../runtime-v2/tools.js';
import type {
  ChildFailurePolicy,
  ChildRunOutcome,
  ConversationState,
  OrchestrationInput,
  OrchestrationScope,
} from './contracts.js';
import { ChildRunner } from './childRunner.js';

export interface AgentToolOptions<TChildContext = unknown, TOutput = string> {
  readonly name?: string;
  readonly description?: string;
  readonly mapInput?: (input: JsonValue) => OrchestrationInput;
  readonly childContext?: (input: JsonValue) => TChildContext;
  readonly failurePolicy?: ChildFailurePolicy;
  readonly effect?: ToolBehavior['effect'];
  readonly idempotencyKey?: (input: JsonValue) => string | undefined;
  readonly metadata?: Readonly<JsonObject>;
  readonly _output?: TOutput;
}

export interface AgentToolInvocation<TChildContext = unknown> {
  readonly parent: OrchestrationScope;
  readonly conversation: ConversationState;
  readonly callId: string;
  readonly input: JsonValue;
  readonly context?: TChildContext;
}

export interface AgentToolInvocationResult<TOutput = string> {
  readonly mode: 'agent-as-tool';
  readonly ownerBefore: ConversationState['owner'];
  readonly ownerAfter: ConversationState['owner'];
  readonly conversation: ConversationState;
  readonly toolResult: ToolResultItem;
  readonly child: ChildRunOutcome<TOutput>;
}

export interface RuntimeToolAdapterOptions<TManagerContext> {
  readonly scope: (
    managerContext: TManagerContext,
    execution: ToolExecutionContext<TManagerContext>,
  ) => OrchestrationScope;
  readonly managerAgentId?: (
    managerContext: TManagerContext,
    execution: ToolExecutionContext<TManagerContext>,
  ) => string;
  readonly inputSchema?: ToolSchema<JsonValue>;
}

/** Agent-as-tool is a child invocation; its internal transcript never takes ownership. */
export class AgentTool<TChildContext = unknown, TOutput = string> {
  readonly name: string;
  readonly description: string;

  constructor(
    readonly agent: AgentSpec<TChildContext, TOutput>,
    private readonly runner: ChildRunner,
    private readonly options: AgentToolOptions<TChildContext, TOutput> = {},
  ) {
    this.name = (options.name ?? agent.id).trim();
    this.description = options.description ?? agent.description ?? `Delegate to ${agent.name}.`;
    if (!this.name) throw new Error('Agent tool name must not be empty.');
  }

  async invoke(
    invocation: AgentToolInvocation<TChildContext>,
  ): Promise<AgentToolInvocationResult<TOutput>> {
    if (!invocation.callId.trim()) throw new Error('Agent tool callId must not be empty.');
    const child = await this.runner.run({
      parent: invocation.parent,
      agent: this.agent,
      input: this.mapInput(invocation.input),
      context: invocation.context ?? this.options.childContext?.(invocation.input),
      // A delegated failure is normally data for the manager, not ownership loss.
      failurePolicy: this.options.failurePolicy ?? { mode: 'collect' },
      effect: this.options.effect,
      idempotencyKey: this.options.idempotencyKey?.(invocation.input),
      metadata: this.options.metadata,
      sessionMode: 'child',
    });
    const toolResult: ToolResultItem = child.status === 'completed'
      ? {
          type: 'tool_result',
          callId: invocation.callId,
          name: this.name,
          status: 'success',
          output: childResultJson(child),
        }
      : {
          type: 'tool_result',
          callId: invocation.callId,
          name: this.name,
          status: 'error',
          output: {
            childRunId: child.scope.runId,
            error: {
              name: child.error.name,
              message: child.error.message,
              code: child.error.code ?? null,
            },
          },
        };

    const conversation: ConversationState = {
      owner: invocation.conversation.owner,
      items: [...invocation.conversation.items, toolResult],
    };
    return {
      mode: 'agent-as-tool',
      ownerBefore: invocation.conversation.owner,
      ownerAfter: invocation.conversation.owner,
      conversation,
      toolResult,
      child,
    };
  }

  /** Adapter for runtime-v2 ToolRegistry; the manager runtime creates the final item. */
  asRuntimeTool<TManagerContext>(
    adapter: RuntimeToolAdapterOptions<TManagerContext>,
  ): RuntimeTool<TManagerContext, JsonValue, JsonValue> {
    const inputSchema = adapter.inputSchema ?? JSON_VALUE_SCHEMA;
    return {
      descriptor: {
        name: this.name,
        description: this.description,
        input: inputSchema,
        behavior: { effect: this.options.effect ?? 'side-effect' },
      },
      execute: async (execution, input): Promise<ToolOutput<JsonValue>> => {
        const managerContext = execution.context;
        const parent = adapter.scope(managerContext, execution);
        const managerAgentId = adapter.managerAgentId?.(managerContext, execution) ?? 'manager';
        const result = await this.invoke({
          parent,
          conversation: {
            owner: { agentId: managerAgentId, runId: execution.runId },
            items: [],
          },
          callId: execution.callId,
          input,
        });
        return { value: result.toolResult.output };
      },
    };
  }

  private mapInput(input: JsonValue): OrchestrationInput {
    if (this.options.mapInput) return this.options.mapInput(input);
    return typeof input === 'string' ? input : JSON.stringify(input);
  }
}

export function agentAsTool<TChildContext = unknown, TOutput = string>(
  agent: AgentSpec<TChildContext, TOutput>,
  runner: ChildRunner,
  options: AgentToolOptions<TChildContext, TOutput> = {},
): AgentTool<TChildContext, TOutput> {
  return new AgentTool(agent, runner, options);
}

const JSON_VALUE_SCHEMA: ToolSchema<JsonValue> = Object.freeze({
  parse(value: unknown): JsonValue {
    assertJsonValue(value, 'Agent tool input');
    return value;
  },
  jsonSchema: {},
});

function childResultJson<TOutput>(
  child: Extract<ChildRunOutcome<TOutput>, { status: 'completed' }>,
): JsonObject {
  assertJsonValue(child.result.output, 'Agent child output');
  return {
    childRunId: child.scope.runId,
    agentId: child.result.agentId,
    status: child.result.status,
    output: child.result.output,
    usage: {
      requests: child.result.usage.requests,
      inputTokens: child.result.usage.inputTokens,
      outputTokens: child.result.usage.outputTokens,
      totalTokens: child.result.usage.totalTokens,
      cacheReadTokens: child.result.usage.cacheReadTokens,
      cacheWriteTokens: child.result.usage.cacheWriteTokens,
      reasoningTokens: child.result.usage.reasoningTokens,
      audioInputTokens: child.result.usage.audioInputTokens,
      audioOutputTokens: child.result.usage.audioOutputTokens,
      costUsd: child.result.usage.costUsd,
    },
  };
}
