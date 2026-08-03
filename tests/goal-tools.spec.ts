import { describe, expect, it } from 'vitest';

import { GoalService } from '../src/goal/goalService.js';
import {
  createGoalTools,
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  PLAN_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
} from '../src/goal/goalTools.js';
import { GOAL_METADATA_KEY, type GoalSessionPort } from '../src/goal/goalStore.js';
import { buildGoalPrompt } from '../src/goal/goalPrompt.js';
import type { Goal } from '../src/goal/types.js';
import { GOAL_SCHEMA_VERSION } from '../src/goal/types.js';

class MemoryGoalPort implements GoalSessionPort {
  metadata: Record<string, unknown> = {};
  readGoalMetadata(): unknown {
    return this.metadata[GOAL_METADATA_KEY];
  }
  async writeGoalMetadata(value: Goal | undefined): Promise<void> {
    if (value === undefined) delete this.metadata[GOAL_METADATA_KEY];
    else this.metadata[GOAL_METADATA_KEY] = value;
  }
}

function makeTools() {
  const port = new MemoryGoalPort();
  const service = new GoalService({ port, now: () => '2026-07-29T00:00:00Z' });
  const tools = createGoalTools({ getGoalService: () => service });
  return { tools, service, port };
}

const ctx = {} as never;

describe('goal tools', () => {
  it('GetGoal returns null when no goal exists', async () => {
    const { tools } = makeTools();
    const get = tools.find(t => t.name === GET_GOAL_TOOL_NAME)!;
    const result = await get.execute({}, ctx);
    expect(result).toEqual({ goal: null });
  });

  it('CreateGoal then GetGoal round-trips the objective', async () => {
    const { tools } = makeTools();
    const create = tools.find(t => t.name === CREATE_GOAL_TOOL_NAME)!;
    const get = tools.find(t => t.name === GET_GOAL_TOOL_NAME)!;
    await create.execute({ objective: 'ship feature', completionCriteria: 'tests pass' }, ctx);
    const result = await get.execute({}, ctx) as { goal: { objective: string; status: string } };
    expect(result.goal.objective).toBe('ship feature');
    expect(result.goal.status).toBe('active');
  });

  it('UpdateGoal records progress when note is provided', async () => {
    const { tools } = makeTools();
    const create = tools.find(t => t.name === CREATE_GOAL_TOOL_NAME)!;
    const update = tools.find(t => t.name === UPDATE_GOAL_TOOL_NAME)!;
    await create.execute({ objective: 'goal' }, ctx);
    const result = await update.execute({ note: 'made progress' }, ctx) as { ok: boolean; goal: { evidence: unknown[] } };
    expect(result.ok).toBe(true);
    expect(result.goal.evidence).toHaveLength(1);
  });

  it('UpdateGoal requires a note for progress-only updates', async () => {
    const { tools } = makeTools();
    const create = tools.find(t => t.name === CREATE_GOAL_TOOL_NAME)!;
    const update = tools.find(t => t.name === UPDATE_GOAL_TOOL_NAME)!;
    await create.execute({ objective: 'goal' }, ctx);
    const result = await update.execute({}, ctx) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/note/);
  });

  it('UpdateGoal complete creates a runtime-settled completion request', async () => {
    const { tools } = makeTools();
    const create = tools.find(t => t.name === CREATE_GOAL_TOOL_NAME)!;
    const update = tools.find(t => t.name === UPDATE_GOAL_TOOL_NAME)!;
    await create.execute({ objective: 'goal' }, ctx);
    const noNote = await update.execute({ status: 'complete' }, ctx) as { ok: boolean };
    expect(noNote.ok).toBe(false);
    const result = await update.execute({ status: 'complete', note: 'criteria met' }, ctx) as { ok: boolean; goal: { status: string } };
    expect(result.ok).toBe(true);
    expect(result.goal.status).toBe('active');
    expect((result.goal as unknown as { completionRequest?: unknown }).completionRequest).toBeTruthy();
  });

  it('PlanGoal writes a structured ordered frontier', async () => {
    const { tools } = makeTools();
    const create = tools.find(t => t.name === CREATE_GOAL_TOOL_NAME)!;
    const plan = tools.find(t => t.name === PLAN_GOAL_TOOL_NAME)!;
    await create.execute({ objective: 'goal' }, ctx);
    const result = await plan.execute({
      reason: 'decompose bootstrap item',
      items: [
        { id: 'test', priority: 'P0', taskClass: 'verification', text: 'run tests' },
        { id: 'ship', priority: 'P1', text: 'ship change', dependsOn: ['test'] },
      ],
    }, ctx) as { ok: boolean; goal: { workItems: Array<{ id: string }> } };
    expect(result.ok).toBe(true);
    expect(result.goal.workItems.map(item => item.id)).toEqual(['test', 'ship']);
  });

  it('UpdateGoal blocks only after the same reason is reported three times', async () => {
    const { tools } = makeTools();
    const create = tools.find(t => t.name === CREATE_GOAL_TOOL_NAME)!;
    const update = tools.find(t => t.name === UPDATE_GOAL_TOOL_NAME)!;
    await create.execute({ objective: 'goal' }, ctx);
    const noReason = await update.execute({ status: 'blocked' }, ctx) as { ok: boolean };
    expect(noReason.ok).toBe(false);
    const first = await update.execute({ status: 'blocked', reason: 'missing key', turn: 4 }, ctx) as { ok: boolean; goal: { status: string } };
    const second = await update.execute({ status: 'blocked', reason: 'missing key', turn: 5 }, ctx) as { ok: boolean; goal: { status: string } };
    const result = await update.execute({ status: 'blocked', reason: 'missing key', turn: 6 }, ctx) as { ok: boolean; goal: { status: string; blockAudit: Array<{ reason: string; turn?: number; repeat?: number }> } };
    expect(first.goal.status).toBe('active');
    expect(second.goal.status).toBe('active');
    expect(result.ok).toBe(true);
    expect(result.goal.status).toBe('blocked');
    expect(result.goal.blockAudit.at(-1)!.reason).toBe('missing key');
    expect(result.goal.blockAudit.at(-1)!.turn).toBe(6);
    expect(result.goal.blockAudit.at(-1)!.repeat).toBe(3);
  });

  it('all goal tools are read-only (no permission prompt)', async () => {
    const { tools } = makeTools();
    for (const t of tools) {
      expect(t.isReadOnly?.({})).toBe(true);
    }
  });
});

describe('buildGoalPrompt', () => {
  it('returns undefined for no goal or a complete goal', () => {
    expect(buildGoalPrompt(null)).toBeUndefined();
    const complete: Goal = {
      version: GOAL_SCHEMA_VERSION, objective: 'done', status: 'complete',
      consumption: { turns: 0, toolIterations: 0, tokens: 0 },
      evidence: [], blockAudit: [], turnReceipts: [], workItems: [], workItemRequests: [], planRevision: 0, replanAudit: [], createdAt: 't', updatedAt: 't', revision: 0,
    };
    expect(buildGoalPrompt(complete)).toBeUndefined();
  });

  it('includes objective, status, criteria, budget, and latest evidence', () => {
    const goal: Goal = {
      version: GOAL_SCHEMA_VERSION,
      objective: 'ship checkpoint',
      status: 'active',
      completionCriteria: 'tests pass',
      budget: { maxTurns: 10, maxTokens: 50000 },
      consumption: { turns: 2, toolIterations: 3, tokens: 1200 },
      evidence: [
        { at: 't1', note: 'old' },
        { at: 't2', note: 'latest progress' },
      ],
      blockAudit: [],
      turnReceipts: [],
      workItems: [], workItemRequests: [], planRevision: 0, replanAudit: [],
      createdAt: 't0',
      updatedAt: 't2',
      revision: 2,
    };
    const prompt = buildGoalPrompt(goal)!;
    expect(prompt).toContain('objective: ship checkpoint');
    expect(prompt).toContain('status: active');
    expect(prompt).toContain('completion criteria: tests pass');
    expect(prompt).toContain('budget: 10 turns, 50000 tokens');
    expect(prompt).toContain('last progress: latest progress');
    expect(prompt).not.toContain('old');
  });

  it('surfaces blocked reason and repeat escalation', () => {
    const goal: Goal = {
      version: GOAL_SCHEMA_VERSION, objective: 'x', status: 'blocked',
      consumption: { turns: 0, toolIterations: 0, tokens: 0 },
      evidence: [], blockAudit: [{ at: 't', reason: 'no key', repeat: 3 }], turnReceipts: [], workItems: [], workItemRequests: [], planRevision: 0, replanAudit: [],
      createdAt: 't', updatedAt: 't', revision: 1,
    };
    const prompt = buildGoalPrompt(goal)!;
    expect(prompt).toContain('blocked reason: no key');
    expect(prompt).toMatch(/repeated 3x/);
  });
});
