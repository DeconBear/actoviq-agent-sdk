import { describe, it, expect } from 'vitest';
import { createCommandRegistry, registerBuiltinCommands, type CommandContext } from '../src/commands.js';

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    currentSessionId: 'test-session-1',
    onClear: () => {},
    getCompactState: async () => ({ compactCount: 5 }),
    compact: async () => ({ summarizedCount: 10 }),
    dream: async () => {},
    getTools: () => [{ name: 'read', description: 'Read a file' }, { name: 'bash', description: 'Run a command' }],
    getSkills: () => [{ name: 'code-review', description: 'Review code' }],
    getAgents: () => [{ name: 'assistant', description: 'General assistant' }],
    getSessions: () => [
      { id: 'test-session-1', title: 'Test Session' },
      { id: 'other-session', title: 'Other' },
    ],
    createSession: async () => {},
    switchSession: async () => {},
    deleteSession: async () => {},
    getScheduledTasks: async () => [
      { id: 'heartbeat', schedule: '*/5 * * * *', nextRunAt: '2026-05-09T12:00:00Z' },
    ],
    saveCheckpoint: async () => ({ id: 'cp-123' }),
    listCheckpoints: async () => [{ id: 'cp-123', label: 'before-merge' }, { id: 'cp-456', label: 'after-merge' }],
    restoreCheckpoint: async () => {},
    getModel: () => 'claude-sonnet-4-6',
    setModel: async () => true,
    listModels: () => ['claude-sonnet-4-6', 'claude-opus-4-7'],
    getBuddyStatus: () => 'Buddy is active: claude-code-reviewer',
    ...overrides,
  };
}

describe('CommandRegistry', () => {
  it('registers and retrieves commands', () => {
    const reg = createCommandRegistry();
    reg.register({ name: 'test', description: 'A test command', handler: () => 'ok' });
    expect(reg.get('test')).toBeDefined();
    expect(reg.get('test')!.description).toBe('A test command');
  });

  it('supports aliases', () => {
    const reg = createCommandRegistry();
    reg.register({ name: 'test', aliases: ['t'], description: 'Test', handler: () => 'ok' });
    expect(reg.get('t')).toBe(reg.get('test'));
  });

  it('lists deduplicated commands', () => {
    const reg = createCommandRegistry();
    reg.register({ name: 'b', description: 'B', handler: () => 'b' });
    reg.register({ name: 'a', description: 'A', handler: () => 'a' });
    const list = reg.list();
    expect(list.map(c => c.name)).toEqual(['a', 'b']);
  });

  it('matches commands from input text', () => {
    const reg = createCommandRegistry();
    reg.register({ name: 'help', description: 'Help', handler: () => 'help' });
    expect(reg.match('/help')?.name).toBe('help');
    expect(reg.match('/help something')?.name).toBe('help');
    expect(reg.match('not a command')).toBeNull();
  });
});

describe('Builtin commands', () => {
  it('/help returns command list', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('help')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('/help');
    expect(result).toContain('/clear');
    expect(result).toContain('/tools');
  });

  it('/clear returns empty string', async () => {
    let cleared = false;
    const ctx = makeContext({ onClear: () => { cleared = true; } });
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, ctx);
    const cmd = reg.get('clear')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toBe('');
  });

  it('/memory returns compact state', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('memory')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('Compact count');
    expect(result).toContain('5');
  });

  it('/tools lists tools', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('tools')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('read');
    expect(result).toContain('bash');
    expect(result).toContain('Read a file');
  });

  it('/skills lists skills', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('skills')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('code-review');
  });

  it('/agents lists agents', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('agents')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('assistant');
  });

  it('/session list shows sessions with active marker', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('session')!;
    const result = await Promise.resolve(cmd.handler('list'));
    // IDs are truncated with .slice(0, 8)
    expect(result).toContain('test-ses');
    expect(result).toContain('Test Session');
  });

  it('/scheduler shows tasks', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('scheduler')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('heartbeat');
    expect(result).toContain('*/5 * * * *');
  });

  it('/checkpoint list shows checkpoints', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('checkpoint')!;
    const result = await Promise.resolve(cmd.handler('list'));
    expect(result).toContain('before-merge');
    expect(result).toContain('after-merge');
  });

  it('/checkpoint save returns checkpoint id', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('checkpoint')!;
    const result = await Promise.resolve(cmd.handler('save my-checkpoint'));
    expect(result).toContain('cp-123');
  });

  it('/buddy shows status', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('buddy')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('Buddy is active');
  });

  it('/model shows current model', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('model')!;
    const result = await Promise.resolve(cmd.handler(''));
    expect(result).toContain('claude-sonnet-4-6');
  });

  it('/model list shows available models', async () => {
    const reg = createCommandRegistry();
    registerBuiltinCommands(reg, makeContext());
    const cmd = reg.get('model')!;
    const result = await Promise.resolve(cmd.handler('list'));
    expect(result).toContain('claude-sonnet-4-6');
    expect(result).toContain('claude-opus-4-7');
  });
});
