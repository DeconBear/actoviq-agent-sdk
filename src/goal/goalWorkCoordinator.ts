import { AgentPool } from '../team/agentPool.js';
import { ProjectGoalStore } from './projectGoalStore.js';
import type { GoalHandoffReceipt, GoalWorkClaim } from './types.js';

export interface GoalWorkerIdentity {
  agentId: string;
  roleScopes?: string[];
}

export type GoalWorkerOutcome =
  | { kind: 'completed'; evidenceRefs: string[] }
  | { kind: 'handoff'; reason: string; toAgentId?: string; toAgentRoleScopes?: string[]; evidenceRefs?: string[] }
  | { kind: 'released'; reason: string };

export interface GoalWorkerRunResult {
  worker: GoalWorkerIdentity;
  claim?: GoalWorkClaim;
  outcome?: GoalWorkerOutcome;
  handoff?: GoalHandoffReceipt;
  skipped?: true;
  error?: string;
}

/** Symmetric worker coordination: SQLite owns claims; AgentPool only limits concurrency. */
export class GoalWorkCoordinator {
  constructor(
    private readonly store: ProjectGoalStore,
    private readonly pool: AgentPool,
  ) {}

  claim(goalId: string, worker: GoalWorkerIdentity, leaseMs?: number): GoalWorkClaim | undefined {
    const claim = this.store.claimNextWork({
      goalId,
      agentId: worker.agentId,
      ...(worker.roleScopes ? { roleScopes: worker.roleScopes } : {}),
      ...(leaseMs !== undefined ? { leaseMs } : {}),
    });
    if (claim) this.store.markClaimRunning(claim.claimToken);
    return claim;
  }

  async runWorkers(input: {
    goalId: string;
    workers: GoalWorkerIdentity[];
    leaseMs?: number;
    acquireTimeoutMs?: number;
    run: (claim: GoalWorkClaim, worker: GoalWorkerIdentity) => Promise<GoalWorkerOutcome>;
  }): Promise<GoalWorkerRunResult[]> {
    return Promise.all(input.workers.map(async worker => {
      const slot = await this.pool.acquire(input.acquireTimeoutMs);
      let claim: GoalWorkClaim | undefined;
      try {
        claim = this.claim(input.goalId, worker, input.leaseMs);
        if (!claim) return { worker, skipped: true };
        const outcome = await input.run(claim, worker);
        if (outcome.kind === 'handoff') {
          const handoff = this.store.handoffWork({
            claimToken: claim.claimToken,
            reason: outcome.reason,
            ...(outcome.toAgentId ? { toAgentId: outcome.toAgentId } : {}),
            ...(outcome.toAgentRoleScopes ? { toAgentRoleScopes: outcome.toAgentRoleScopes } : {}),
            ...(outcome.evidenceRefs ? { evidenceRefs: outcome.evidenceRefs } : {}),
            ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
          });
          return {
            worker,
            claim,
            outcome,
            ...(handoff ? { handoff: handoff.receipt } : {}),
            ...(!handoff ? { error: 'Handoff target is outside the work-item scope.' } : {}),
          };
        }
        if (outcome.kind === 'completed') {
          if (!this.store.completeWorkClaim(claim.claimToken, outcome.evidenceRefs)) {
            this.store.releaseWorkClaim(claim.claimToken, 'completion_evidence_missing');
            return { worker, claim, outcome, error: 'Worker completion requires evidence refs.' };
          }
        } else {
          this.store.releaseWorkClaim(claim.claimToken, outcome.reason);
        }
        return { worker, claim, outcome };
      } catch (error) {
        if (claim) this.store.releaseWorkClaim(claim.claimToken, 'worker_failed');
        return {
          worker,
          ...(claim ? { claim } : {}),
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        slot.release();
      }
    }));
  }
}
