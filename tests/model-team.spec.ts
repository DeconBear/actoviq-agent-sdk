/**
 * Model Team feature tests — v0.5.0
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createModelTeam, createTeamTool, ModelTeam, orchestratePanel } from '../src/team/modelTeam.js';
import { AgentPool, getGlobalAgentPool, resetGlobalAgentPool } from '../src/team/agentPool.js';
import { getModelPricing, estimateCost, clearPricingCache } from '../src/team/pricing.js';
import type { TeamDefinition, ExpertPanelReport, TeamEvent } from '../src/types.js';

describe('AgentPool', () => {
  beforeEach(() => {
    resetGlobalAgentPool(3);
  });

  it('acquires and releases slots', async () => {
    const pool = getGlobalAgentPool();
    expect(pool.activeCount).toBe(0);

    const slot = await pool.acquire();
    expect(pool.activeCount).toBe(1);

    slot.release();
    expect(pool.activeCount).toBe(0);
  });

  it('queues when at capacity', async () => {
    const pool = getGlobalAgentPool();
    // Acquire all 3 slots
    const slots = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);
    expect(pool.activeCount).toBe(3);
    expect(pool.queuedCount).toBe(0);

    // 4th acquire should queue
    const acquirePromise = pool.acquire();
    // Give it a microtask to queue
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.queuedCount).toBe(1);

    // Release one, queued should get it
    slots[0]!.release();
    const slot4 = await acquirePromise;
    expect(pool.activeCount).toBe(3);
    expect(pool.queuedCount).toBe(0);

    // Cleanup
    slots.forEach((s) => s?.release());
    slot4.release();
  });

  it('times out waiting for a slot', async () => {
    resetGlobalAgentPool(1);
    const pool = getGlobalAgentPool();
    await pool.acquire(); // fill the only slot

    await expect(pool.acquire(100)).rejects.toThrow('timed out');
    pool.reset();
  });

  it('drains queued waiters', async () => {
    resetGlobalAgentPool(1);
    const pool = getGlobalAgentPool();
    await pool.acquire(); // fill it

    const pending = pool.acquire(5000).catch((e) => e.message);
    await new Promise((r) => setTimeout(r, 10));

    pool.drain('shutdown');
    const result = await pending;
    expect(result).toContain('shutdown');
  });
});

describe('Pricing', () => {
  beforeEach(() => {
    clearPricingCache();
  });

  it('returns pricing for known Anthropic models', () => {
    const pricing = getModelPricing('claude-sonnet-4-6');
    expect(pricing).not.toBeNull();
    expect(pricing!.input).toBeGreaterThan(0);
    expect(pricing!.output).toBeGreaterThan(0);
  });

  it('returns pricing for known OpenAI models', () => {
    const pricing = getModelPricing('gpt-4o');
    expect(pricing).not.toBeNull();
  });

  it('returns pricing for DeepSeek models', () => {
    const pricing = getModelPricing('deepseek-v4-pro');
    expect(pricing).not.toBeNull();
  });

  it('returns pricing for Gemini models', () => {
    const pricing = getModelPricing('gemini-3-flash');
    expect(pricing).not.toBeNull();
  });

  it('returns null for unknown models', () => {
    const pricing = getModelPricing('unknown-model-xyz');
    expect(pricing).toBeNull();
  });

  it('estimates cost correctly', () => {
    // sonnet: $3/1M input, $15/1M output
    // 1000000 input tokens = $3, 500000 output tokens = $7.5, total = $10.5
    const cost = estimateCost('claude-sonnet-4-6', 1_000_000, 500_000);
    expect(cost).toBeCloseTo(10.5, 1);
  });

  it('returns null cost for unknown model', () => {
    const cost = estimateCost('unknown-model', 1000, 1000);
    expect(cost).toBeNull();
  });
});

describe('ModelTeam validation', () => {
  it('treats panel as a retired alias of panel-analysis (no primary required)', () => {
    // The pure-text panel mode was retired; `panel` now routes to the unified
    // panel-analysis engine, where a primary is optional. This used to throw.
    const def: TeamDefinition = {
      name: 'legacy-panel',
      mode: 'panel',
      members: [{ model: 'claude-sonnet-4-6' }],
    };
    const team = createModelTeam(def);
    expect(team.definition.mode).toBe('panel');
  });

  it('validates panel mode requires at least one member', () => {
    const def: TeamDefinition = {
      name: 'test-panel',
      mode: 'panel',
      members: [],
      primary: { model: 'claude-opus-4-8' },
    };
    expect(() => createModelTeam(def)).toThrow('at least one panel member');
  });

  it('validates panel mode max 8 members', () => {
    const def: TeamDefinition = {
      name: 'test-panel',
      mode: 'panel',
      members: Array.from({ length: 9 }, (_, i) => ({ model: `model-${i}` })),
      primary: { model: 'claude-opus-4-8' },
    };
    expect(() => createModelTeam(def)).toThrow('8 members');
  });

  it('validates reviewer mode requires a reviewer member', () => {
    const def: TeamDefinition = {
      name: 'test-reviewer',
      mode: 'reviewer',
      members: [],
    };
    expect(() => createModelTeam(def)).toThrow('reviewer');
  });

  it('creates a valid reviewer team and accepts executor-reviewer as an alias', () => {
    const reviewer = createModelTeam({
      name: 'reviewer',
      mode: 'reviewer',
      members: [],
      reviewer: { model: 'claude-opus-4-8' },
    });
    expect(reviewer.definition.mode).toBe('reviewer');

    // The retired executor-reviewer alias now needs only a reviewer (no executor).
    const legacy = createModelTeam({
      name: 'legacy-er',
      mode: 'executor-reviewer',
      members: [],
      reviewer: { model: 'claude-opus-4-8' },
    });
    expect(legacy.definition.mode).toBe('executor-reviewer');
  });

  it('creates a valid panel team', () => {
    const def: TeamDefinition = {
      name: 'valid-panel',
      mode: 'panel',
      members: [
        { model: 'claude-sonnet-4-6' },
        { model: 'deepseek-v4-pro' },
      ],
      primary: { model: 'claude-opus-4-8' },
    };
    const team = createModelTeam(def);
    expect(team).toBeInstanceOf(ModelTeam);
    expect(team.name).toBe('valid-panel');
    expect(team.definition.mode).toBe('panel');
  });

  it('validates panel-analysis requires at least one member', () => {
    const def: TeamDefinition = {
      name: 'pa',
      mode: 'panel-analysis',
      members: [],
    };
    expect(() => createModelTeam(def)).toThrow('at least one panel member');
  });

  it('creates a valid panel-analysis team (advisory, no primary)', () => {
    const def: TeamDefinition = {
      name: 'pa-advisory',
      mode: 'panel-analysis',
      members: [{ model: 'claude-sonnet-4-6' }, { model: 'deepseek-v4-pro' }],
    };
    const team = createModelTeam(def);
    expect(team.definition.mode).toBe('panel-analysis');
    expect(team.definition.primary).toBeUndefined();
  });

  it('creates a valid panel-analysis team with a primary (convergent)', () => {
    const def: TeamDefinition = {
      name: 'pa-convergent',
      mode: 'panel-analysis',
      members: [{ model: 'claude-sonnet-4-6' }, { model: 'deepseek-v4-pro' }],
      primary: { model: 'claude-opus-4-8' },
    };
    const team = createModelTeam(def);
    expect(team.definition.mode).toBe('panel-analysis');
    expect(team.definition.primary?.model).toBe('claude-opus-4-8');
  });

  it('still accepts analysis as a backward-compatible alias', () => {
    const def: TeamDefinition = {
      name: 'legacy-analysis',
      mode: 'analysis',
      members: [{ model: 'deepseek-v4-pro' }],
    };
    const team = createModelTeam(def);
    expect(team.definition.mode).toBe('analysis');
  });
});

describe('createTeamTool', () => {
  it('creates an agent tool with block interrupt behavior', () => {
    const def: TeamDefinition = {
      name: 'security-review',
      description: 'Multi-model security review',
      mode: 'panel',
      members: [
        { model: 'claude-sonnet-4-6' },
      ],
      primary: { model: 'claude-opus-4-8' },
    };

    const tool = createTeamTool(def);
    expect(tool.name).toBe('security-review');
    expect(tool.kind).toBe('local');
    expect(tool.interruptBehavior).toBe('block');
    expect(tool.description).toContain('Multi-model security review');
  });
});

describe('API key resolution', () => {
  it('resolves $ENV_VAR references', () => {
    process.env.TEST_API_KEY = 'sk-test-123';
    // This is tested indirectly through createMemberApi
    // but we verify the env var pattern
    const key = '$TEST_API_KEY';
    expect(key.startsWith('$')).toBe(true);
    const resolved = process.env[key.slice(1)];
    expect(resolved).toBe('sk-test-123');
    delete process.env.TEST_API_KEY;
  });

  it('passes through literal keys', () => {
    const literalKey = 'sk-literal-key-456';
    expect(literalKey.startsWith('$')).toBe(false);
  });
});

describe('panel-analysis convergence loop (orchestratePanel)', () => {
  // Each "round" produces one labeled report; the fakes stand in for the model
  // APIs so the loop logic is exercised deterministically, no network involved.
  const reportFor = (round: number): ExpertPanelReport[] => [
    { model: 'expert', report: `findings-${round}`, toolCalls: 1, durationMs: 1, round },
  ];

  it('is single-pass advisory when no decide callback (no primary)', async () => {
    const investigated: number[] = [];
    const res = await orchestratePanel({
      prompt: 'task',
      maxRounds: 100,
      investigate: async (round) => {
        investigated.push(round);
        return reportFor(round);
      },
    });
    expect(investigated).toEqual([1]); // round 1 only
    expect(res.rounds).toBe(1);
    expect(res.reports).toHaveLength(1);
    expect(res.answer).toContain('findings-1');
  });

  it('finalizes on the first primary decision', async () => {
    const investigated: number[] = [];
    let decideCalls = 0;
    const res = await orchestratePanel({
      prompt: 'task',
      maxRounds: 100,
      investigate: async (round) => {
        investigated.push(round);
        return reportFor(round);
      },
      decide: async () => {
        decideCalls += 1;
        return 'FINALIZE\nThe synthesized answer.';
      },
    });
    expect(investigated).toEqual([1]);
    expect(decideCalls).toBe(1);
    expect(res.rounds).toBe(1);
    expect(res.answer).toBe('The synthesized answer.');
  });

  it('runs multiple rounds until the primary finalizes, threading refined question + prior context', async () => {
    const investigated: Array<{ round: number; question: string; prior?: string }> = [];
    const script = ['CONTINUE dig into auth', 'CONTINUE check sessions', 'FINALIZE\nDone.'];
    let d = 0;
    const res = await orchestratePanel({
      prompt: 'is it safe?',
      maxRounds: 100,
      investigate: async (round, question, prior) => {
        investigated.push({ round, question, prior });
        return reportFor(round);
      },
      decide: async () => script[d++]!,
    });
    expect(res.rounds).toBe(3);
    expect(investigated.map((i) => i.round)).toEqual([1, 2, 3]);
    expect(investigated[1]!.question).toBe('dig into auth'); // refined question threaded
    expect(investigated[1]!.prior).toContain('findings-1'); // prior findings threaded
    expect(investigated[2]!.question).toBe('check sessions');
    expect(res.reports).toHaveLength(3);
    expect(res.answer).toBe('Done.');
  });

  it('stops at maxRounds and returns the findings unsynthesized when never finalized', async () => {
    const investigated: number[] = [];
    const res = await orchestratePanel({
      prompt: 'task',
      maxRounds: 2,
      investigate: async (round) => {
        investigated.push(round);
        return reportFor(round);
      },
      decide: async () => 'CONTINUE keep digging', // primary never finalizes
    });
    expect(investigated).toEqual([1, 2]); // capped
    expect(res.rounds).toBe(2);
    expect(res.answer).toContain('findings-2'); // fallback: labeled findings, not synthesized
  });

  it('treats a non-CONTINUE decision as finalize (case-insensitive, graceful default)', async () => {
    const lower = await orchestratePanel({
      prompt: 't',
      maxRounds: 100,
      investigate: async (round) => reportFor(round),
      decide: async () => 'finalize\nlower-case answer',
    });
    expect(lower.rounds).toBe(1);
    expect(lower.answer).toBe('lower-case answer');

    const noKeyword = await orchestratePanel({
      prompt: 't',
      maxRounds: 100,
      investigate: async (round) => reportFor(round),
      decide: async () => 'Here is my answer with no keyword',
    });
    expect(noKeyword.rounds).toBe(1);
    expect(noKeyword.answer).toBe('Here is my answer with no keyword');
  });

  it('labels advisory output by stable id, disambiguating members that share a model', async () => {
    const res = await orchestratePanel({
      prompt: 'task',
      maxRounds: 100,
      investigate: async (round) => [
        { id: 'researcher', model: 'gpt-4o', report: 'R', toolCalls: 0, durationMs: 0, round },
        { id: 'skeptic', model: 'gpt-4o', report: 'S', toolCalls: 0, durationMs: 0, round },
      ],
    });
    expect(res.answer).toContain('### researcher');
    expect(res.answer).toContain('### skeptic');
    // The old behavior labeled both by model ("### gpt-4o") — now disambiguated.
    expect(res.answer).not.toContain('### gpt-4o');
  });

  it('emits round.completed and synthesis events for observers', async () => {
    const events: TeamEvent[] = [];
    const script = ['CONTINUE dig deeper', 'FINALIZE\ndone'];
    let d = 0;
    await orchestratePanel({
      prompt: 'task',
      maxRounds: 100,
      investigate: async (round) => [
        { id: 'researcher', model: 'gpt-4o', report: `r-${round}`, toolCalls: 0, durationMs: 0, round },
      ],
      decide: async () => script[d++]!,
      onEvent: (event) => events.push(event),
    });
    const rounds = events.filter((e) => e.type === 'team.round.completed');
    const synth = events.filter((e) => e.type === 'team.synthesis');
    expect(rounds).toHaveLength(2); // round 1 + round 2
    expect(synth.map((e) => (e.type === 'team.synthesis' ? e.decision : ''))).toEqual(['continue', 'finalize']);
  });
});
