import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createManagerTools,
  buildManagerSystemPrompt,
  buildUpdateProgressPrompt,
  formatManagerUpdatePreview,
  shouldIncludeGitHubDigest,
  parseGitHubRepoFromRemote,
  fetchGitHubPrDigest,
  readManagerConfig,
  writeManagerConfig,
  readProjectPlanFile,
  writeProjectPlanFile,
  readProgressFile,
  managerPlanPath,
  managerProgressPath,
  resolveManagerReadRoots,
  DEFAULT_MANAGER_CONFIG,
} from '../src/manager/projectManager.js';
import {
  listScheduledAutomationTasks,
  upsertScheduledAutomationTask,
} from '../src/scheduling/taskPersistence.js';
import type { AgentToolDefinition } from '../src/types.js';

let workDir: string;
let homeDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-work-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-home-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

async function tools(config = DEFAULT_MANAGER_CONFIG): Promise<AgentToolDefinition[]> {
  return createManagerTools({ workDir, homeDir, config });
}

describe('Manager tool surface (plan §4.2 hard constraints)', () => {
  it('exposes only the restricted read + progress-write tools', async () => {
    const names = (await tools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'Glob',
      'Grep',
      'IssueComment',
      'IssueCreate',
      'IssueGet',
      'IssueList',
      'IssueUpdate',
      'PlanWrite',
      'ProgressWrite',
      'Read',
      'WebFetch',
    ].sort());
  });

  it('has no shell, edit, team, or delegation tools', async () => {
    const names = new Set((await tools()).map((t) => t.name));
    for (const forbidden of ['Bash', 'Write', 'Edit', 'Task', 'TeamAsk', 'EnterWorktree', 'TodoWrite']) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

describe('Manager read scope enforcement', () => {
  it('workspace-only rejects reads outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    try {
      const read = (await tools()).find((t) => t.name === 'Read')!;
      await expect(
        (read.execute as (i: unknown, c: unknown) => Promise<unknown>)({ file_path: secret }, {}),
      ).rejects.toThrow(/read scope violation/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('workspace-only allows reads inside the workspace', async () => {
    fs.writeFileSync(path.join(workDir, 'notes.txt'), 'hello manager');
    const read = (await tools()).find((t) => t.name === 'Read')!;
    const result = await (read.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { file_path: path.join(workDir, 'notes.txt') },
      {},
    );
    expect(JSON.stringify(result)).toContain('hello manager');
  });

  it('explicit-allowlist widens the readable roots', async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-extra-'));
    fs.writeFileSync(path.join(extra, 'doc.md'), 'allowed doc');
    try {
      const cfg = { ...DEFAULT_MANAGER_CONFIG, readScope: 'explicit-allowlist' as const, allowedReadPaths: [extra] };
      const roots = resolveManagerReadRoots(workDir, homeDir, cfg);
      expect(roots.some((r) => path.resolve(r) === path.resolve(extra))).toBe(true);
      const read = (await tools(cfg)).find((t) => t.name === 'Read')!;
      const result = await (read.execute as (i: unknown, c: unknown) => Promise<unknown>)(
        { file_path: path.join(extra, 'doc.md') },
        {},
      );
      expect(JSON.stringify(result)).toContain('allowed doc');
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it('full-access allows reads outside the workspace without allowlist', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-full-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'full access ok');
    try {
      const cfg = { ...DEFAULT_MANAGER_CONFIG, readScope: 'full-access' as const };
      expect(resolveManagerReadRoots(workDir, homeDir, cfg)).toEqual([]);
      const read = (await tools(cfg)).find((t) => t.name === 'Read')!;
      const result = await (read.execute as (i: unknown, c: unknown) => Promise<unknown>)(
        { file_path: secret },
        {},
      );
      expect(JSON.stringify(result)).toContain('full access ok');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the project store (plan/PROGRESS home) is always readable', () => {
    const roots = resolveManagerReadRoots(workDir, homeDir, DEFAULT_MANAGER_CONFIG);
    const planDir = path.dirname(managerPlanPath(workDir, homeDir));
    expect(roots.some((r) => planDir.startsWith(r))).toBe(true);
  });
});

describe('Manager progress documents (plan §4.4)', () => {
  it('PlanWrite writes plan.json in the project store, not the workspace', async () => {
    const planWrite = (await tools()).find((t) => t.name === 'PlanWrite')!;
    await (planWrite.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { milestones: [{ title: 'M1', status: 'active' }], today: ['fix bug'], upcoming: ['ship'] },
      {},
    );
    const plan = await readProjectPlanFile(workDir, homeDir);
    expect(plan.milestones[0]!.title).toBe('M1');
    expect(plan.today).toEqual(['fix bug']);
    // plan.json must live under the home project store, not the workspace.
    expect(managerPlanPath(workDir, homeDir).startsWith(path.resolve(homeDir))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'plan.json'))).toBe(false);
  });

  it('ProgressWrite writes PROGRESS.md in the project store by default (no workspace mirror)', async () => {
    const progressWrite = (await tools()).find((t) => t.name === 'ProgressWrite')!;
    await (progressWrite.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { content: '# Progress\n\nAll good.' },
      {},
    );
    expect(await readProgressFile(workDir, homeDir)).toContain('All good.');
    expect(fs.existsSync(path.join(workDir, '.actoviq', 'PROGRESS.md'))).toBe(false);
  });

  it('ProgressWrite mirrors to the workspace only when opted in', async () => {
    const cfg = { ...DEFAULT_MANAGER_CONFIG, mirrorProgressToWorkspace: true };
    const progressWrite = (await tools(cfg)).find((t) => t.name === 'ProgressWrite')!;
    await (progressWrite.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { content: '# Mirrored' },
      {},
    );
    expect(fs.readFileSync(path.join(workDir, '.actoviq', 'PROGRESS.md'), 'utf8')).toContain('Mirrored');
  });

  it('the default config never writes any workspace file', async () => {
    const before = fs.readdirSync(workDir);
    const all = await tools();
    const planWrite = all.find((t) => t.name === 'PlanWrite')!;
    const progressWrite = all.find((t) => t.name === 'ProgressWrite')!;
    await (planWrite.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { milestones: [], today: [], upcoming: [] },
      {},
    );
    await (progressWrite.execute as (i: unknown, c: unknown) => Promise<unknown>)({ content: 'x' }, {});
    expect(fs.readdirSync(workDir)).toEqual(before);
  });
});

describe('Manager config (manager.json)', () => {
  it('round-trips config through the project store', async () => {
    await writeManagerConfig(workDir, homeDir, {
      model: 'claude-x',
      readScope: 'workspace+docs',
      allowedReadPaths: ['/docs'],
      mirrorProgressToWorkspace: true,
      promptOverride: 'Track the v2 launch.',
    });
    const cfg = await readManagerConfig(workDir, homeDir);
    expect(cfg.model).toBe('claude-x');
    expect(cfg.readScope).toBe('workspace+docs');
    expect(cfg.allowedReadPaths).toEqual(['/docs']);
    expect(cfg.mirrorProgressToWorkspace).toBe(true);
    expect(cfg.promptOverride).toBe('Track the v2 launch.');
  });

  it('falls back to safe defaults for missing/invalid config', async () => {
    const cfg = await readManagerConfig(workDir, homeDir);
    expect(cfg.readScope).toBe('workspace-only');
    expect(cfg.mirrorProgressToWorkspace).toBe(false);
  });
});

describe('Manager prompts', () => {
  it('system prompt states the hard rules', () => {
    const prompt = buildManagerSystemPrompt(workDir);
    expect(prompt).toContain('NEVER modify project source code');
    expect(prompt).toContain('PlanWrite');
    expect(prompt).toContain('ProgressWrite');
    expect(prompt).toContain('You do not run teams');
  });

  it('system prompt appends the promptOverride', () => {
    const prompt = buildManagerSystemPrompt(workDir, { ...DEFAULT_MANAGER_CONFIG, promptOverride: 'Focus on QA.' });
    expect(prompt).toContain('Focus on QA.');
  });

  it('update prompt embeds host-collected context sections', () => {
    const prompt = buildUpdateProgressPrompt({
      instruction: 'mark milestone 2 blocked',
      gitSummary: 'branch: main',
      conversationSummaries: '- [2026-07-05] Fix login (3 msgs)',
      githubDigest: 'Open PRs (1 shown):\n#42 Fix auth',
      currentPlanJson: '{"milestones":[]}',
      currentIssuesJson: '[{"key":"ISS-1","status":"in_review","linkedSessions":[{"id":"worker-1"}]}]',
      currentProgress: '# Progress',
    });
    expect(prompt).toContain('mark milestone 2 blocked');
    expect(prompt).toContain('branch: main');
    expect(prompt).toContain('Fix login');
    expect(prompt).toContain('Open PRs');
    expect(prompt).toContain('--- Current plan.json ---');
    expect(prompt).toContain('--- Current issues.json summary ---');
    expect(prompt).toContain('linked-session evidence');
    expect(prompt).toContain('--- Current PROGRESS.md ---');
  });

  it('formatManagerUpdatePreview summarizes plan and progress', async () => {
    await writeProjectPlanFile(workDir, homeDir, {
      milestones: [{ title: 'M1', status: 'done' }],
      today: ['task a'],
      upcoming: [],
    });
    const preview = formatManagerUpdatePreview(
      await readProjectPlanFile(workDir, homeDir),
      '# Progress\nHello',
    );
    expect(preview).toContain('1 milestones');
    expect(preview).toContain('PROGRESS.md');
    expect(preview).toContain('M1 (done)');
  });

  it('shouldIncludeGitHubDigest matches github-pr-digest and github+pr phrases', () => {
    expect(shouldIncludeGitHubDigest('github-pr-digest')).toBe(true);
    expect(shouldIncludeGitHubDigest('Summarize open GitHub PRs')).toBe(true);
    expect(shouldIncludeGitHubDigest('daily standup')).toBe(false);
  });

  it('parseGitHubRepoFromRemote handles https and ssh remotes', () => {
    expect(parseGitHubRepoFromRemote('https://github.com/acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseGitHubRepoFromRemote('git@github.com:acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseGitHubRepoFromRemote('https://gitlab.com/acme/widget.git')).toBeNull();
  });

  it('fetchGitHubPrDigest returns null without token', async () => {
    expect(await fetchGitHubPrDigest(undefined, 'acme', 'widget')).toBeNull();
  });
});

describe('Manager scheduled tasks (kind: manager, plan M2)', () => {
  it('persists and lists kind:"manager" tasks in scheduled-tasks.json', async () => {
    const task = await upsertScheduledAutomationTask(workDir, {
      kind: 'manager',
      cron: '0 9 * * 1-5',
      input: 'daily standup summary',
    });
    expect(task.kind).toBe('manager');
    expect(task.name).toBe('Manager progress update');
    expect(task.input).toBe('daily standup summary');
    const listed = await listScheduledAutomationTasks(workDir);
    expect(listed.find((t) => t.id === task.id)?.kind).toBe('manager');
  });
});
