import { describe, expect, it } from 'vitest';

import { GoalService } from '../src/goal/goalService.js';
import {
  GOAL_METADATA_KEY,
  normalizeGoal,
  type GoalSessionPort,
} from '../src/goal/goalStore.js';
import type { Goal } from '../src/goal/types.js';

/** Deterministic in-memory GoalSessionPort for tests. */
class MemoryGoalPort implements GoalSessionPort {
  metadata: Record<string, unknown> = {};
  reads = 0;
  writes = 0;

  readGoalMetadata(): unknown {
    this.reads += 1;
    return this.metadata[GOAL_METADATA_KEY];
  }

  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    this.writes += 1;
    if (value === undefined) {
      delete this.metadata[GOAL_METADATA_KEY];
    } else {
      this.metadata[GOAL_METADATA_KEY] = value;
    }
  }
}

function makeService(clock: () => string): { service: GoalService; port: MemoryGoalPort } {
  const port = new MemoryGoalPort();
  const service = new GoalService({ port, now: clock });
  return { service, port };
}

async function settleCompletedGoal(service: GoalService): Promise<void> {
  await service.requestCompletion({ note: 'done' });
  await service.settleTurn({
    receipt: {
      id: 'goal-turn:complete', runId: 'complete', at: fixedClock(), outcome: 'validated_completion',
      evidenceRefs: [], validation: { status: 'passed' },
      usage: { turns: 1, toolIterations: 0, tokens: 1 },
    },
    evidence: [],
    completionAccepted: true,
  });
}

const fixedClock = (() => {
  let t = 0;
  return () => {
    t += 1;
    return `2026-07-29T00:00:${String(t).padStart(2, '0')}Z`;
  };
})();

describe('GoalService', () => {
  it('creates a goal with versioned schema and active status', async () => {
    const { service } = makeService(fixedClock);
    const goal = await service.create({ objective: 'Ship the checkpoint feature' });
    expect(goal.version).toBe(2);
    expect(goal.status).toBe('active');
    expect(goal.objective).toBe('Ship the checkpoint feature');
    expect(goal.evidence).toEqual([]);
    expect(goal.blockAudit).toEqual([]);
    expect(goal.turnReceipts).toEqual([]);
    expect(goal.consumption).toEqual({ turns: 0, toolIterations: 0, tokens: 0 });
    expect(goal.revision).toBe(0);
    expect(goal.createdAt).toBe(goal.updatedAt);
  });

  it('rejects an empty objective', async () => {
    const { service } = makeService(fixedClock);
    await expect(service.create({ objective: '   ' })).rejects.toThrow(/empty/);
  });

  it('records progress evidence only while active, bumping revision', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    const r1 = await service.progress({ note: 'wrote tests', toolCalls: 3, tokens: 100 });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.goal.evidence).toHaveLength(1);
      expect(r1.goal.evidence[0]!.note).toBe('wrote tests');
      expect(r1.goal.evidence[0]!.toolCalls).toBe(3);
      expect(r1.goal.revision).toBe(1);
    }
    const r2 = await service.progress({ note: '  ' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('invalid_transition');
  });

  it('records a completion request and lets runtime settlement complete it', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal', completionCriteria: 'tests pass' });
    const empty = await service.complete({ note: '   ' });
    expect(empty.ok).toBe(false);
    const r = await service.requestCompletion({ note: 'all tests green', evidenceRefs: ['tool:test'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal.status).toBe('active');
      expect(r.goal.completionRequest?.evidenceRefs).toEqual(['tool:test']);
    }
    const settled = await service.settleTurn({
      receipt: {
        id: 'goal-turn:r1', runId: 'r1', at: fixedClock(), outcome: 'validated_completion',
        evidenceRefs: ['tool:test'], validation: { status: 'passed' },
        usage: { turns: 1, toolIterations: 1, tokens: 10 },
      },
      evidence: [{ at: fixedClock(), note: 'tests passed', ref: 'tool:test', verified: true }],
      completionAccepted: true,
    });
    expect(settled.ok && settled.goal.status).toBe('complete');
  });

  it('records block audit and counts consecutive repeats from the audit tail', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    // Two blocks with the same reason, then a different reason resets the run.
    await service.block({ reason: 'no API key', turn: 0 });
    await service.block({ reason: 'no API key', turn: 1 });
    const different = await service.block({ reason: 'network down', turn: 2 });
    expect(different.ok).toBe(true);
    if (different.ok) {
      // A different reason starts a new run at one and does not block yet.
      expect(different.goal.blockAudit.at(-1)!.repeat).toBe(1);
      expect(different.goal.status).toBe('active');
    }
  });

  it('flags repeat when the same reason recurs 3 times consecutively', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    // Three consecutive blocks with the same reason.
    await service.block({ reason: 'blocked', turn: 0 });
    await service.block({ reason: 'blocked', turn: 1 });
    const third = await service.block({ reason: 'blocked', turn: 2 });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.goal.blockAudit.at(-1)!.repeat).toBe(3);
      expect(third.goal.status).toBe('blocked');
    }
  });

  it('requires a fresh three-report audit after a blocked goal is resumed', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    await service.block({ reason: 'no credential' });
    await service.block({ reason: 'no credential' });
    await service.block({ reason: 'no credential' });
    const resumed = await service.transition('active');
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.goal.blockAudit).toEqual([]);
    const first = await service.block({ reason: 'no credential' });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.goal.status).toBe('active');
      expect(first.goal.blockAudit.at(-1)?.repeat).toBe(1);
    }
  });

  it('forbids blocking a completed goal', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    await settleCompletedGoal(service);
    const r = await service.block({ reason: 'wait' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_transition');
  });

  it('UI transition pauses/resumes but cannot complete', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    const paused = await service.transition('paused');
    expect(paused.ok).toBe(true);
    if (paused.ok) expect(paused.goal.status).toBe('paused');
    // progress is rejected while paused
    const prog = await service.progress({ note: 'x' });
    expect(prog.ok).toBe(false);
    const resumed = await service.transition('active');
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.goal.status).toBe('active');
  });

  it('transition on completed goal is rejected', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    await settleCompletedGoal(service);
    const r = await service.transition('paused');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_transition');
  });

  it('revise detects revision conflicts', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    const stale = await service.revise({ objective: 'new', expectedRevision: 99 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('conflict');
    const ok = await service.revise({ objective: 'new', expectedRevision: 0 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.goal.objective).toBe('new');
      expect(ok.goal.revision).toBe(1);
    }
  });

  it('detects stale expected revisions for progress and terminal transitions', async () => {
    const { service } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    const progress = await service.progress({ note: 'first', expectedRevision: 0 });
    expect(progress.ok).toBe(true);
    const staleProgress = await service.progress({ note: 'stale', expectedRevision: 0 });
    expect(staleProgress).toMatchObject({ ok: false, reason: 'conflict' });
    const staleComplete = await service.complete({ note: 'done', expectedRevision: 0 });
    expect(staleComplete).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('clear removes the goal', async () => {
    const { service, port } = makeService(fixedClock);
    await service.create({ objective: 'goal' });
    await service.clear();
    expect(await service.read()).toBeNull();
    expect(GOAL_METADATA_KEY in port.metadata).toBe(false);
  });
});

describe('normalizeGoal (legacy migration)', () => {
  it('normalizes a legacy {objective,status,setAt} object into v1', () => {
    const raw = { objective: 'legacy goal', status: 'paused', setAt: '2026-01-01T00:00:00Z' };
    const goal = normalizeGoal(raw, '2026-07-29T00:00:00Z');
    expect(goal).not.toBeNull();
    expect(goal!.version).toBe(2);
    expect(goal!.objective).toBe('legacy goal');
    expect(goal!.status).toBe('paused');
    expect(goal!.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(goal!.evidence).toEqual([]);
    expect(goal!.blockAudit).toEqual([]);
    expect(goal!.turnReceipts).toEqual([]);
    expect(goal!.consumption).toEqual({ turns: 0, toolIterations: 0, tokens: 0 });
    expect(goal!.revision).toBe(0);
  });

  it('defaults legacy status to active when missing', () => {
    const goal = normalizeGoal({ objective: 'x' }, '2026-07-29T00:00:00Z');
    expect(goal!.status).toBe('active');
  });

  it('returns null for absent or malformed values', () => {
    expect(normalizeGoal(null, 'now')).toBeNull();
    expect(normalizeGoal(undefined, 'now')).toBeNull();
    expect(normalizeGoal('not-json', 'now')).toBeNull();
    expect(normalizeGoal({ status: 'active' }, 'now')).toBeNull(); // no objective
    expect(normalizeGoal(42, 'now')).toBeNull();
  });

  it('parses a legacy string-encoded goal', () => {
    const raw = JSON.stringify({ objective: 'string goal', status: 'complete' });
    const goal = normalizeGoal(raw, '2026-07-29T00:00:00Z');
    expect(goal!.objective).toBe('string goal');
    expect(goal!.status).toBe('complete');
  });
});
