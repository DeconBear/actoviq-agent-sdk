import type {
  AgentSpec,
  ErrorItem,
  InputItem,
  JsonObject,
  MaybePromise,
} from '../core/index.js';
import type {
  ChildFailurePolicy,
  ChildRunOutcome,
  ConversationState,
  OrchestrationScope,
} from './contracts.js';
import { ChildRunner } from './childRunner.js';

export interface HandoffFilterContext {
  readonly parent: OrchestrationScope;
  readonly conversation: ConversationState;
}

export interface HandoffSpec<TContext = unknown, TOutput = string> {
  readonly id: string;
  readonly target: AgentSpec<TContext, TOutput>;
  readonly description?: string;
  readonly inputFilter?: (
    input: readonly InputItem[],
    context: HandoffFilterContext,
  ) => MaybePromise<readonly InputItem[]>;
  readonly childContext?: TContext;
  readonly failurePolicy?: ChildFailurePolicy;
  readonly metadata?: Readonly<JsonObject>;
}

export interface HandoffInvocation {
  readonly parent: OrchestrationScope;
  readonly conversation: ConversationState;
}

export interface HandoffResult<TOutput = string> {
  readonly mode: 'handoff';
  readonly ownershipTransferred: true;
  readonly ownerBefore: ConversationState['owner'];
  readonly ownerAfter: ConversationState['owner'];
  readonly filteredInput: readonly InputItem[];
  readonly conversation: ConversationState;
  readonly child: ChildRunOutcome<TOutput>;
}

/** A handoff moves the canonical conversation; it is not represented as a manager tool result. */
export async function executeHandoff<TContext, TOutput = string>(
  runner: ChildRunner,
  spec: HandoffSpec<TContext, TOutput>,
  invocation: HandoffInvocation,
): Promise<HandoffResult<TOutput>> {
  if (!spec.id.trim()) throw new Error('Handoff id must not be empty.');
  const source = [...invocation.conversation.items];
  const filtered = spec.inputFilter
    ? [...await spec.inputFilter(source, {
        parent: invocation.parent,
        conversation: invocation.conversation,
      })]
    : source;
  const prepared = runner.runtime.beforeHandoff
    ? [...await runner.runtime.beforeHandoff({
        sourceAgentId: invocation.conversation.owner.agentId,
        targetAgent: spec.target,
        handoffId: spec.id,
        input: filtered,
        parentRunId: invocation.parent.runId,
        signal: invocation.parent.signal,
        deadline: invocation.parent.deadline,
        metadata: spec.metadata,
      })]
    : filtered;

  const child = await runner.run({
    parent: invocation.parent,
    agent: spec.target,
    input: prepared,
    context: spec.childContext,
    // Preserve the ownership transition in the returned state even when the target fails.
    failurePolicy: spec.failurePolicy ?? { mode: 'collect' },
    metadata: spec.metadata,
    sessionMode: 'transfer',
  });
  const ownerAfter = { agentId: spec.target.id, runId: child.scope.runId };
  const conversation: ConversationState = {
    owner: ownerAfter,
    items: child.status === 'completed'
      ? [...prepared, ...child.result.items]
      : [...prepared, handoffFailureItem(spec.id, spec.target.id, child)],
  };
  return {
    mode: 'handoff',
    ownershipTransferred: true,
    ownerBefore: invocation.conversation.owner,
    ownerAfter,
    filteredInput: prepared,
    conversation,
    child,
  };
}

function handoffFailureItem(
  handoffId: string,
  targetAgentId: string,
  child: Extract<ChildRunOutcome<unknown>, { status: 'failed' }>,
): ErrorItem {
  return {
    type: 'error',
    source: 'handoff',
    code: child.error.code ?? 'HANDOFF_FAILED',
    message: `Handoff "${handoffId}" to "${targetAgentId}" failed: ${child.error.message}`,
    retryable: false,
  };
}
