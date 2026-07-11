import { describe, expect, it } from 'vitest';

import {
  readPreToolUseHooks,
  createPreToolUseHookClassifier,
  normalizeUserHooksConfig,
  toSettingsHooksBlock,
} from '../src/hooks/userHooks.js';

describe('readPreToolUseHooks', () => {
  it('reads a hooks.PreToolUse[] block from settings', () => {
    const hooks = readPreToolUseHooks({ hooks: { PreToolUse: [
      { matcher: 'Bash', command: 'echo no', description: 'guard bash' },
      { matcher: '*', command: 'echo all' },
    ] } });
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toMatchObject({ matcher: 'Bash', command: 'echo no', description: 'guard bash' });
  });

  it('preserves enabled: false', () => {
    const hooks = readPreToolUseHooks({ hooks: { PreToolUse: [
      { matcher: 'Bash', command: 'exit 1', enabled: false },
    ] } });
    expect(hooks).toEqual([{ matcher: 'Bash', command: 'exit 1', enabled: false }]);
  });

  it('ignores malformed entries and missing hooks block', () => {
    expect(readPreToolUseHooks({})).toEqual([]);
    expect(readPreToolUseHooks({ hooks: {} })).toEqual([]);
    expect(readPreToolUseHooks({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })).toEqual([]); // missing command
    expect(readPreToolUseHooks({ hooks: { PreToolUse: 'not-an-array' } })).toEqual([]);
    expect(readPreToolUseHooks(null)).toEqual([]);
  });
});

describe('normalizeUserHooksConfig / toSettingsHooksBlock', () => {
  it('round-trips a hooks payload', () => {
    const config = normalizeUserHooksConfig({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', command: 'exit 0', enabled: false }],
        PostToolUse: [{ matcher: '*', command: 'echo done', description: 'notify' }],
        SessionStart: [{ command: 'echo hi' }],
      },
    });
    expect(config.PreToolUse[0]).toMatchObject({ matcher: 'Bash', enabled: false });
    const block = toSettingsHooksBlock(config);
    expect(block.PreToolUse).toEqual([{ matcher: 'Bash', command: 'exit 0', enabled: false }]);
    expect(block.PostToolUse).toEqual([{ matcher: '*', command: 'echo done', description: 'notify' }]);
    expect(block.SessionStart).toEqual([{ command: 'echo hi' }]);
  });
});

describe('createPreToolUseHookClassifier', () => {
  const ctx = (tool: string) => ({
    runId: 'r', sessionId: 's', workDir: '.', toolName: tool, publicName: tool,
    input: { command: 'ls' }, prompt: '', iteration: 0,
  });

  it('returns undefined when no hooks configured (no-op pass-through)', async () => {
    const classifier = createPreToolUseHookClassifier(() => []);
    expect(await classifier(ctx('Bash'))).toBeUndefined();
  });

  it('denies when a matched hook command exits non-zero', async () => {
    const classifier = createPreToolUseHookClassifier(() => [
      { matcher: 'Bash', command: 'exit 1' },
    ]);
    const result = await classifier(ctx('Bash'));
    expect(result?.behavior).toBe('deny');
    expect(result?.reason).toContain('PreToolUse hook blocked');
  });

  it('allows when a matched hook command exits zero', async () => {
    const classifier = createPreToolUseHookClassifier(() => [
      { matcher: 'Bash', command: 'exit 0' },
    ]);
    expect(await classifier(ctx('Bash'))).toBeUndefined();
  });

  it('denies when hook stdout starts with BLOCK', async () => {
    const classifier = createPreToolUseHookClassifier(() => [
      { matcher: 'Write', command: 'echo BLOCKED by policy' },
    ]);
    const result = await classifier(ctx('Write'));
    expect(result?.behavior).toBe('deny');
  });

  it('only matches tools that fit the matcher', async () => {
    const classifier = createPreToolUseHookClassifier(() => [
      { matcher: 'Bash', command: 'exit 1' },
    ]);
    // Read tool does not match the Bash matcher — no-op.
    expect(await classifier(ctx('Read'))).toBeUndefined();
    // Bash does match — denied.
    expect((await classifier(ctx('Bash')))?.behavior).toBe('deny');
  });

  it('the "*" matcher matches every tool', async () => {
    const classifier = createPreToolUseHookClassifier(() => [
      { matcher: '*', command: 'exit 1' },
    ]);
    expect((await classifier(ctx('Grep')))?.behavior).toBe('deny');
    expect((await classifier(ctx('Edit')))?.behavior).toBe('deny');
  });

  it('skips hooks with enabled: false', async () => {
    const classifier = createPreToolUseHookClassifier(() => [
      { matcher: 'Bash', command: 'exit 1', enabled: false },
    ]);
    expect(await classifier(ctx('Bash'))).toBeUndefined();
  });
});
