/**
 * Worktree feature tests — v0.5.0
 */
import { describe, it, expect } from 'vitest';
import { WorktreeService, generateWorktreeName } from '../src/worktree/worktreeService.js';
import { parseWorktreeInclude, matchesPattern as matchesWorktreeIncludePattern } from '../src/worktree/worktreeInclude.js';
import { ENTER_WORKTREE_TOOL_NAME, createEnterWorktreeTool } from '../src/tools/enterWorktree.js';
import { EXIT_WORKTREE_TOOL_NAME, createExitWorktreeTool } from '../src/tools/exitWorktree.js';

describe('WorktreeService', () => {
  it('creates a WorktreeService with default settings', () => {
    const service = new WorktreeService(process.cwd());
    expect(service.currentWorkDir).toBeTruthy();
    expect(service.isInWorktree).toBe(false);
    expect(service.worktreePath).toBeUndefined();
  });

  it('generates auto worktree names with three parts', () => {
    const name = generateWorktreeName();
    const parts = name.split('-');
    expect(parts.length).toBe(3);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it('generates unique names across multiple calls', () => {
    const names = new Set(Array.from({ length: 20 }, () => generateWorktreeName()));
    expect(names.size).toBeGreaterThan(10); // reasonable uniqueness
  });

  it('detects not-in-worktree state correctly', () => {
    const service = new WorktreeService(process.cwd());
    expect(service.isInWorktree).toBe(false);
    expect(service.worktreePath).toBeUndefined();
    expect(service.worktreeBranch).toBeUndefined();
  });

  it('throws when exiting from main checkout', () => {
    const service = new WorktreeService(process.cwd());
    expect(() => service.exitWorktree()).toThrow('Not in a worktree');
  });
});

describe('.worktreeinclude', () => {
  it('parses simple patterns ignoring comments and empty lines', async () => {
    const content = [
      '.env',
      '',
      'config/secrets.json',
      '# this is a comment',
      '*.log',
    ].join('\n');

    // Write temp file
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpFile = path.join(os.tmpdir(), `worktreeinclude-test-${Date.now()}`);
    await fs.writeFile(tmpFile, content, 'utf-8');

    try {
      const patterns = await parseWorktreeInclude(tmpFile);
      expect(patterns).toEqual(['.env', 'config/secrets.json', '*.log']);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it('matches wildcard patterns correctly', () => {
    expect(matchesWorktreeIncludePattern('.env', '.env')).toBe(true);
    expect(matchesWorktreeIncludePattern('.env.local', '.env*')).toBe(true);
    expect(matchesWorktreeIncludePattern('config/secrets.json', 'config/secrets.json')).toBe(true);
    expect(matchesWorktreeIncludePattern('src/app.ts', '*.log')).toBe(false);
    expect(matchesWorktreeIncludePattern('logs/error.log', '*.log')).toBe(true);
    expect(matchesWorktreeIncludePattern('deep/nested/logs/app.log', '**/*.log')).toBe(true);
  });

  it('handles anchored patterns (leading /)', () => {
    expect(matchesWorktreeIncludePattern('.env', '/.env')).toBe(true);
    expect(matchesWorktreeIncludePattern('subdir/.env', '/.env')).toBe(false);
  });
});

describe('EnterWorktree tool', () => {
  it('creates a tool with the correct name', () => {
    const tool = createEnterWorktreeTool(() => undefined);
    expect(tool.name).toBe(ENTER_WORKTREE_TOOL_NAME);
    expect(tool.kind).toBe('local');
  });

  it('returns unavailable message when no worktree service', async () => {
    const tool = createEnterWorktreeTool(() => undefined);
    const result = await tool.execute(
      { name: 'test' },
      { runId: 'r1', cwd: process.cwd(), metadata: {}, prompt: '', iteration: 1 },
    );
    expect(result).toContain('not available');
  });

  it('has correct input schema', () => {
    const tool = createEnterWorktreeTool(() => undefined);
    expect(tool.inputJsonSchema.type).toBe('object');
    expect(tool.inputJsonSchema.properties).toHaveProperty('name');
    expect(tool.inputJsonSchema.properties).toHaveProperty('path');
    expect(tool.inputJsonSchema.properties).toHaveProperty('branch');
    expect(tool.inputJsonSchema.properties).toHaveProperty('pr');
  });
});

describe('ExitWorktree tool', () => {
  it('creates a tool with the correct name', () => {
    const tool = createExitWorktreeTool(() => undefined);
    expect(tool.name).toBe(EXIT_WORKTREE_TOOL_NAME);
    expect(tool.kind).toBe('local');
  });

  it('returns unavailable message when no worktree service', async () => {
    const tool = createExitWorktreeTool(() => undefined);
    const result = await tool.execute({}, {} as any);
    expect(result).toContain('not available');
  });

  it('returns not-in-worktree message from a fresh service', async () => {
    const service = new WorktreeService(process.cwd());
    const tool = createExitWorktreeTool(() => service);
    const result = await tool.execute({}, {} as any);
    expect(result).toContain('Not currently in a worktree');
  });
});
