import { randomUUID } from 'node:crypto';

import type { AgentRunResult } from '../types.js';
import { decideGoalExecution, type GoalExecutionDecision } from './goalController.js';
import {
  type GoalContinuationMode,
  type GoalContinuationProfileRef,
  type GoalContinuationState,
  ProjectGoalStore,
} from './projectGoalStore.js';
import type { Goal } from './types.js';

export interface GoalContinuationExecutorInput {
  sessionId: string;
  goalId: string;
  prompt: string;
  decision: Exclude<GoalExecutionDecision, { kind: 'stop' }>;
  executionProfile?: GoalContinuationProfileRef;
  signal?: AbortSignal;
}

export type GoalContinuationExecutor = (
  input: GoalContinuationExecutorInput,
) => Promise<AgentRunResult>;

export type GoalWakeDecision =
  | { kind: 'wake'; goalId: string; sessionId: string; decision: Exclude<GoalExecutionDecision, { kind: 'stop' }> }
  | { kind: 'skip'; reason: 'no_goal' | 'no_session' | 'not_due' | 'leased' | 'stopped'; message: string };

export interface GoalContinuationRunResult {
  started: boolean;
  turns: number;
  reason: string;
  goal: Goal | null;
  continuation?: GoalContinuationState;
}

export class GoalContinuationService {
  constructor(
    private readonly store: ProjectGoalStore,
    private readonly executor: GoalContinuationExecutor,
  ) {}

  decide(goalId: string, options: { force?: boolean; now?: Date } = {}): GoalWakeDecision {
    const goal = this.store.readSnapshot(goalId);
    if (!goal) return { kind: 'skip', reason: 'no_goal', message: 'Goal does not exist.' };
    const continuation = this.store.continuationState(goalId);
    const sessionId = continuation?.sessionId;
    if (!sessionId) return { kind: 'skip', reason: 'no_session', message: 'Goal has no attached session.' };
    const decision = decideGoalExecution(goal);
    if (decision.kind === 'stop') {
      return { kind: 'skip', reason: 'stopped', message: decision.message };
    }
    const now = options.now ?? new Date();
    if (
      !options.force
      && continuation?.mode === 'scheduled'
      && continuation.nextWakeAt
      && Date.parse(continuation.nextWakeAt) > now.getTime()
    ) {
      return { kind: 'skip', reason: 'not_due', message: `Next wake is ${continuation.nextWakeAt}.` };
    }
    if (
      continuation?.leaseOwner
      && continuation.leaseExpiresAt
      && Date.parse(continuation.leaseExpiresAt) > now.getTime()
    ) {
      return { kind: 'skip', reason: 'leased', message: `Goal wake is leased by ${continuation.leaseOwner}.` };
    }
    return { kind: 'wake', goalId, sessionId, decision };
  }

  async run(input: {
    goalId: string;
    mode?: GoalContinuationMode;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<GoalContinuationRunResult> {
    let turns = 0;
    let lastReason = 'no runnable work';
    while (!input.signal?.aborted) {
      const wake = this.decide(input.goalId, { force: input.force === true || turns > 0 });
      if (wake.kind === 'skip') {
        return {
          started: turns > 0,
          turns,
          reason: wake.message,
          goal: this.store.readSnapshot(input.goalId),
          continuation: this.store.continuationState(input.goalId),
        };
      }
      const continuation = this.store.continuationState(input.goalId);
      const mode = input.mode ?? continuation?.mode ?? 'manual';
      const owner = `goal-wake:${randomUUID()}`;
      if (!this.store.acquireContinuationLease(input.goalId, owner)) {
        return {
          started: turns > 0,
          turns,
          reason: 'Another Goal wake owns the continuation lease.',
          goal: this.store.readSnapshot(input.goalId),
          continuation: this.store.continuationState(input.goalId),
        };
      }
      try {
        const result = await this.executor({
          sessionId: wake.sessionId,
          goalId: wake.goalId,
          prompt: buildContinuationPrompt(wake.decision),
          decision: wake.decision,
          ...(continuation?.executionProfile
            ? { executionProfile: continuation.executionProfile }
            : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        turns += 1;
        const goal = this.store.readSnapshot(input.goalId);
        const receipt = goal?.turnReceipts.find(item => item.runId === result.runId)
          ?? goal?.turnReceipts.at(-1);
        const outcome = receipt?.outcome ?? 'no_change';
        lastReason = outcome;
        this.store.settleContinuation({ goalId: input.goalId, owner, outcome });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.settleContinuation({
          goalId: input.goalId,
          owner,
          outcome: input.signal?.aborted ? 'interrupted' : 'failed',
          error: message,
        });
        return {
          started: turns > 0,
          turns,
          reason: message,
          goal: this.store.readSnapshot(input.goalId),
          continuation: this.store.continuationState(input.goalId),
        };
      }
      if (mode !== 'foreground') break;
    }
    return {
      started: turns > 0,
      turns,
      reason: input.signal?.aborted ? 'aborted' : lastReason,
      goal: this.store.readSnapshot(input.goalId),
      continuation: this.store.continuationState(input.goalId),
    };
  }
}

function buildContinuationPrompt(decision: Exclude<GoalExecutionDecision, { kind: 'stop' }>): string {
  const discipline = [
    'Stay inside the session working directory for every create/edit/verify step.',
    'Do not write into ~/.hadamard, project data directories, temp caches, or any path outside the working directory.',
    'Before requesting completion, re-read the concrete artifact from disk under the working directory and cite that tool result as evidence.',
    'If an exact user or external dependency is required, record a gate/deferred item instead of guessing.',
  ];
  if (decision.kind === 'replan') {
    return [
      'Continue the active session Goal in replanning mode.',
      `Trigger: ${decision.trigger}.`,
      'Inspect the current Goal, use PlanGoal to make a material frontier change, then execute the highest-priority runnable item.',
      ...discipline,
    ].join('\n');
  }
  return [
    'Continue the active session Goal autonomously.',
    decision.workItemId ? `Advance work item ${decision.workItemId}.` : `Mode: ${decision.mode}.`,
    'Use the Goal tools to record plan or work-item requests, and validate concrete results before requesting completion.',
    ...discipline,
  ].join('\n');
}
