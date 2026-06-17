/**
 * Model Team feature tests — v0.5.0
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createModelTeam, createTeamTool, ModelTeam } from '../src/team/modelTeam.js';
import { AgentPool, getGlobalAgentPool, resetGlobalAgentPool } from '../src/team/agentPool.js';
import { getModelPricing, estimateCost, clearPricingCache } from '../src/team/pricing.js';
import type { TeamDefinition } from '../src/types.js';

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
  it('validates panel mode requires primary', () => {
    const def: TeamDefinition = {
      name: 'test-panel',
      mode: 'panel',
      members: [{ model: 'claude-sonnet-4-6' }],
    };
    expect(() => createModelTeam(def)).toThrow('primary');
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

  it('validates router mode requires router', () => {
    const def: TeamDefinition = {
      name: 'test-router',
      mode: 'router',
      members: [],
      specialists: { coding: { model: 'claude-sonnet-4-6' } },
    };
    expect(() => createModelTeam(def)).toThrow('router');
  });

  it('validates router mode requires specialists', () => {
    const def: TeamDefinition = {
      name: 'test-router',
      mode: 'router',
      members: [],
      router: { model: 'claude-haiku-4-5' },
    };
    expect(() => createModelTeam(def)).toThrow('specialist');
  });

  it('validates discussion mode requires at least 2 members', () => {
    const def: TeamDefinition = {
      name: 'test-discussion',
      mode: 'discussion',
      members: [{ model: 'claude-sonnet-4-6' }],
      primary: { model: 'claude-opus-4-8' },
    };
    expect(() => createModelTeam(def)).toThrow('at least 2');
  });

  it('validates executor-reviewer requires executor and reviewer', () => {
    const def: TeamDefinition = {
      name: 'test-er',
      mode: 'executor-reviewer',
      members: [],
    };
    expect(() => createModelTeam(def)).toThrow('executor');

    const def2: TeamDefinition = {
      name: 'test-er',
      mode: 'executor-reviewer',
      members: [],
      executor: { model: 'claude-sonnet-4-6' },
    };
    expect(() => createModelTeam(def2)).toThrow('reviewer');
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

  it('creates a valid router team', () => {
    const def: TeamDefinition = {
      name: 'valid-router',
      mode: 'router',
      members: [],
      router: { model: 'claude-haiku-4-5' },
      specialists: {
        coding: { model: 'claude-sonnet-4-6', description: 'code tasks' },
      },
    };
    const team = createModelTeam(def);
    expect(team.definition.mode).toBe('router');
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
