import { describe, it, expect } from 'vitest';

import {
  buildMemberIdentities,
  preflightMember,
  resolveApiKey,
  runMemberAgent,
} from '../src/team/teamRuntime.js';
import type { TeamEvent } from '../src/types.js';

describe('teamRuntime — member identity', () => {
  it('prefers id → name → role → model and dedupes collisions', () => {
    const ids = buildMemberIdentities([
      { model: 'gpt-4o', role: 'researcher' },
      { model: 'gpt-4o', role: 'skeptic' },
      { model: 'gpt-4o' },
      { model: 'gpt-4o' },
      { model: 'claude', name: 'lead' },
      { model: 'x', id: 'fixed' },
    ]);
    expect(ids.map((i) => i.id)).toEqual(['researcher', 'skeptic', 'gpt-4o', 'gpt-4o#2', 'lead', 'fixed']);
    expect(ids[0]!.role).toBe('researcher');
    expect(ids[2]!.model).toBe('gpt-4o');
  });
});

describe('teamRuntime — preflight', () => {
  it('flags a missing $ENV apiKey', () => {
    delete process.env.__TEAM_TEST_MISSING__;
    const res = preflightMember({ model: 'gpt-4o', apiKey: '$__TEAM_TEST_MISSING__' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('__TEAM_TEST_MISSING__');
  });

  it('passes a present $ENV apiKey, literal keys, and no key', () => {
    process.env.__TEAM_TEST_PRESENT__ = 'sk-x';
    expect(preflightMember({ model: 'gpt-4o', apiKey: '$__TEAM_TEST_PRESENT__' }).ok).toBe(true);
    expect(preflightMember({ model: 'gpt-4o', apiKey: 'sk-literal' }).ok).toBe(true);
    expect(preflightMember({ model: 'gpt-4o' }).ok).toBe(true);
    delete process.env.__TEAM_TEST_PRESENT__;
  });

  it('flags a missing model', () => {
    expect(preflightMember({ model: '' }).ok).toBe(false);
  });
});

describe('teamRuntime — resolveApiKey', () => {
  it('resolves $ENV and passes literals', () => {
    process.env.__TEAM_KEY__ = 'sk-123';
    expect(resolveApiKey('$__TEAM_KEY__')).toBe('sk-123');
    expect(resolveApiKey('sk-literal')).toBe('sk-literal');
    expect(resolveApiKey(undefined)).toBeUndefined();
    delete process.env.__TEAM_KEY__;
  });
});

describe('teamRuntime — runMemberAgent preflight skip (no network)', () => {
  it('skips a misconfigured member with a structured status, never touching the SDK', async () => {
    delete process.env.__TEAM_RUN_MISSING__;
    const events: TeamEvent[] = [];
    const run = await runMemberAgent({
      identity: { id: 'researcher', model: 'gpt-4o', role: 'researcher' },
      member: { model: 'gpt-4o', apiKey: '$__TEAM_RUN_MISSING__' },
      task: 'analyze',
      systemPrompt: 'sys',
      cwd: process.cwd(),
      tools: [],
      maxIterations: 4,
      round: 1,
      onEvent: (event) => events.push(event),
    });

    expect(run.status.ok).toBe(false);
    expect(run.status.skipped).toBe(true);
    expect(run.status.id).toBe('researcher');
    expect(run.inputTokens).toBe(0);
    expect(run.report).toContain('unavailable');
    expect(events.some((e) => e.type === 'team.member.completed' && e.ok === false)).toBe(true);
    // preflight short-circuits before running, so there is no 'started' event.
    expect(events.some((e) => e.type === 'team.member.started')).toBe(false);
  });
});
