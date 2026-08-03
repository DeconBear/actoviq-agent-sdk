import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  encodeHadamardProjectPath,
  getHadamardProjectSessionDirectory,
  loadDefaultHadamardSettings,
  loadJsonConfigFile,
  resolveRuntimeConfig,
} from '../src/index.js';
import { migrateLegacyHadamardProjectData } from '../src/config/projectSessionDirectory.js';
import { addBridgeConfig } from '../src/parity/bridgeConfigs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  clearLoadedJsonConfig();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-sdk-config-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('config loading', () => {
  it('loads a preselected JSON config file from an arbitrary path', async () => {
    const homeDir = await createTempHome();
    const settingsPath = path.join(homeDir, 'my-agent-config.json');

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            HADAMARD_AUTH_TOKEN: 'test-token',
            HADAMARD_BASE_URL: 'https://example.test/hadamard',
            HADAMARD_DEFAULT_MEDIUM_MODEL: 'demo-model',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const settings = await loadJsonConfigFile(settingsPath);

    expect(settings.exists).toBe(true);
    expect(settings.env.HADAMARD_AUTH_TOKEN).toBe('test-token');
    expect(settings.env.HADAMARD_DEFAULT_MEDIUM_MODEL).toBe('demo-model');
    expect(settings.path).toBe(settingsPath);
  });

  it('resolves runtime config from explicit options and the preloaded JSON config', async () => {
    const homeDir = await createTempHome();
    const settingsPath = path.join(homeDir, 'custom-runtime-config.json');

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            HADAMARD_AUTH_TOKEN: 'settings-token',
            HADAMARD_BASE_URL: 'https://example.test/hadamard',
            HADAMARD_DEFAULT_MEDIUM_MODEL: 'settings-model',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await loadJsonConfigFile(settingsPath);

    const config = await resolveRuntimeConfig({
      homeDir,
      model: 'explicit-model',
      workDir: 'E:/demo',
    });

    expect(config.authToken).toBe('settings-token');
    expect(config.baseURL).toBe('https://example.test/hadamard');
    expect(config.model).toBe('explicit-model');
    expect(config.workDir).toBe(path.resolve('E:/demo'));
    expect(config.loadedConfigPath).toBe(settingsPath);
    expect(config.sessionDirectory).toBe(
      getHadamardProjectSessionDirectory('E:/demo', homeDir),
    );
  });

  it('uses a stable readable and collision-safe project key for default session isolation', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'demo');
    const config = await resolveRuntimeConfig({
      homeDir,
      workDir,
      model: 'demo-model',
      authToken: 'test-token',
    });

    expect(config.sessionDirectory).toBe(
      path.join(homeDir, '.hadamard', 'projects', encodeHadamardProjectPath(workDir)),
    );
    // A canonical readable prefix keeps paths recognizable while the hash
    // prevents distinct paths with the same sanitized form from sharing.
    const samplePath = process.platform === 'win32' ? 'E:\\repo\\demo' : '/home/repo/demo';
    const sampleExpected = process.platform === 'win32' ? 'e--repo-demo' : '-home-repo-demo';
    expect(encodeHadamardProjectPath(samplePath)).toMatch(
      new RegExp(`^${sampleExpected}--[0-9a-f]{24}$`),
    );

    const collidingReadablePath = path.join(homeDir, 'workspace', 'a-b');
    const collidingLegacyPath = path.join(homeDir, 'workspace', 'a_b');
    expect(
      encodeHadamardProjectPath(collidingReadablePath).replace(/--[0-9a-f]{24}$/u, ''),
    ).toBe(
      encodeHadamardProjectPath(collidingLegacyPath).replace(/--[0-9a-f]{24}$/u, ''),
    );
    expect(encodeHadamardProjectPath(collidingReadablePath)).not.toBe(
      encodeHadamardProjectPath(collidingLegacyPath),
    );
    expect(encodeHadamardProjectPath('x'.repeat(1_000)).length).toBeLessThanOrEqual(200);
    if (process.platform === 'win32') {
      expect(encodeHadamardProjectPath('E:\\Repo\\Demo')).toBe(
        encodeHadamardProjectPath('e:\\repo\\demo'),
      );
    }
  });

  it('migrates only matching legacy project sessions into the project store', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace');
    const legacySessions = path.join(
      homeDir,
      '.hadamard',
      'actoviq-agent-sdk',
      'sessions',
    );
    await mkdir(legacySessions, { recursive: true });
    await writeFile(
      path.join(legacySessions, 'matching.json'),
      JSON.stringify({ id: 'matching', metadata: { __hadamardWorkDir: workDir } }),
    );
    await writeFile(
      path.join(legacySessions, 'other.json'),
      JSON.stringify({
        id: 'other',
        metadata: { __hadamardWorkDir: path.join(homeDir, 'other') },
      }),
    );

    const config = await resolveRuntimeConfig({
      homeDir,
      workDir,
      model: 'demo-model',
      authToken: 'test-token',
    });

    expect(
      JSON.parse(
        await readFile(path.join(config.sessionDirectory, 'sessions', 'matching.json'), 'utf8'),
      ),
    ).toMatchObject({ id: 'matching' });
    await expect(
      readFile(path.join(config.sessionDirectory, 'sessions', 'other.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('selectively migrates legacy project sessions, archives, executions, and tasks', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'a-b');
    const otherWorkDir = path.join(homeDir, 'workspace', 'a_b');
    const projectKey = encodeHadamardProjectPath(workDir);
    const legacyKey = projectKey.replace(/--[0-9a-f]{24}$/u, '');
    const legacyRoot = path.join(homeDir, '.hadamard', 'projects', legacyKey);
    const targetRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
    const legacySessions = path.join(legacyRoot, 'sessions');
    const legacyArchive = path.join(legacyRoot, 'archive');
    const legacyExecutions = path.join(legacyRoot, 'agent-executions');
    const legacyTasks = path.join(legacyRoot, 'tasks');
    await Promise.all([
      mkdir(path.join(legacySessions, '.checkpoints', 'matching'), { recursive: true }),
      mkdir(path.join(legacySessions, '.checkpoints', 'recovery-child'), { recursive: true }),
      mkdir(path.join(legacySessions, '.checkpoints', 'conflicting-target'), { recursive: true }),
      mkdir(path.join(legacySessions, '.checkpoints', 'existing-owner'), { recursive: true }),
      mkdir(path.join(legacyArchive, '.checkpoints', 'archived'), { recursive: true }),
      mkdir(legacyExecutions, { recursive: true }),
      mkdir(legacyTasks, { recursive: true }),
      mkdir(path.join(legacyRoot, 'mailboxes'), { recursive: true }),
      mkdir(path.join(targetRoot, 'sessions'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(legacySessions, 'matching.json'),
        JSON.stringify({
          id: 'matching',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, 'child.json'),
        JSON.stringify({
          id: 'child',
          parentSessionId: 'matching',
        }),
      ),
      writeFile(
        path.join(legacySessions, 'recovery-child.json'),
        JSON.stringify({
          id: 'recovery-child',
          parentSessionId: 'matching',
        }),
      ),
      writeFile(
        path.join(targetRoot, 'sessions', 'recovery-child.json'),
        JSON.stringify({
          id: 'recovery-child',
          parentSessionId: 'matching',
        }),
      ),
      writeFile(
        path.join(legacySessions, '.checkpoints', 'recovery-child', 'checkpoint.json'),
        JSON.stringify({ id: 'recovered-after-partial-migration' }),
      ),
      writeFile(
        path.join(legacySessions, 'other.json'),
        JSON.stringify({
          id: 'other',
          metadata: { __hadamardWorkDir: otherWorkDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, 'unscoped.json'),
        JSON.stringify({ id: 'unscoped' }),
      ),
      writeFile(
        path.join(legacySessions, '...json'),
        JSON.stringify({
          id: 'unsafe-storage-id',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, 'explicit-other-child.json'),
        JSON.stringify({
          id: 'explicit-other-child',
          parentSessionId: 'matching',
          metadata: { __hadamardWorkDir: otherWorkDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, 'worktree-child.json'),
        JSON.stringify({
          id: 'worktree-child',
          parentSessionId: 'matching',
          originalWorkDir: workDir,
          metadata: {
            __hadamardWorkDir: path.join(workDir, '.worktrees', 'child'),
          },
        }),
      ),
      writeFile(
        path.join(legacySessions, 'conflicting-target.json'),
        JSON.stringify({
          id: 'conflicting-target',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, '.checkpoints', 'conflicting-target', 'checkpoint.json'),
        JSON.stringify({ id: 'must-not-copy' }),
      ),
      writeFile(
        path.join(targetRoot, 'sessions', 'conflicting-target.json'),
        JSON.stringify({
          id: 'conflicting-target',
          metadata: { __hadamardWorkDir: otherWorkDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, 'existing-owner.json'),
        JSON.stringify({
          id: 'existing-owner',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, '.checkpoints', 'existing-owner', 'checkpoint.json'),
        JSON.stringify({ id: 'safe-to-copy' }),
      ),
      writeFile(
        path.join(targetRoot, 'sessions', 'existing-owner.json'),
        JSON.stringify({
          id: 'existing-owner',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacySessions, '.checkpoints', 'matching', 'checkpoint.json'),
        JSON.stringify({ id: 'checkpoint' }),
      ),
      writeFile(
        path.join(legacyArchive, 'archived.json'),
        JSON.stringify({
          id: 'archived',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacyArchive, '.checkpoints', 'archived', 'checkpoint.json'),
        JSON.stringify({ id: 'archived-checkpoint' }),
      ),
      writeFile(
        path.join(legacyExecutions, 'matching-execution.json'),
        JSON.stringify({
          rootExecutionId: 'matching-execution',
          executions: [{
            id: 'matching-execution',
            kind: 'root',
            sessionId: 'matching',
            cwd: workDir,
          }],
        }),
      ),
      writeFile(
        path.join(legacyExecutions, 'other-execution.json'),
        JSON.stringify({
          rootExecutionId: 'other-execution',
          nodes: [{
            id: 'other-execution',
            kind: 'root',
            sessionId: 'other',
            cwd: otherWorkDir,
          }],
        }),
      ),
      writeFile(
        path.join(legacyTasks, 'matching-task.json'),
        JSON.stringify({
          id: 'matching-task',
          workDir,
        }),
      ),
      writeFile(
        path.join(legacyTasks, 'child-task.json'),
        JSON.stringify({
          id: 'child-task',
          workDir: path.join(workDir, '.worktrees', 'child'),
          parentSessionId: 'matching',
        }),
      ),
      writeFile(
        path.join(legacyTasks, 'other-task.json'),
        JSON.stringify({
          id: 'other-task',
          workDir: otherWorkDir,
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'meta.json'),
        JSON.stringify({ status: 'in_progress' }),
      ),
    ]);

    const summary = await migrateLegacyHadamardProjectData({
      homeDir,
      workDir,
      targetDirectory: targetRoot,
    });

    expect(summary).toMatchObject({
      sessions: 3,
      archivedSessions: 1,
      agentExecutions: 1,
      backgroundTasks: 2,
      globalSessions: 0,
      projectArtifacts: 0,
      retainedUnassignedArtifacts: ['mailboxes', 'meta.json'],
      total: 7,
    });
    await expect(
      readFile(path.join(targetRoot, 'sessions', 'matching.json'), 'utf8'),
    ).resolves.toContain('"matching"');
    await expect(
      readFile(path.join(targetRoot, 'sessions', 'child.json'), 'utf8'),
    ).resolves.toContain('"child"');
    await expect(
      readFile(path.join(targetRoot, 'sessions', 'worktree-child.json'), 'utf8'),
    ).resolves.toContain('"worktree-child"');
    await expect(
      readFile(
        path.join(targetRoot, 'sessions', '.checkpoints', 'matching', 'checkpoint.json'),
        'utf8',
      ),
    ).resolves.toContain('"checkpoint"');
    await expect(
      readFile(
        path.join(
          targetRoot,
          'sessions',
          '.checkpoints',
          'existing-owner',
          'checkpoint.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"safe-to-copy"');
    await expect(
      readFile(
        path.join(
          targetRoot,
          'sessions',
          '.checkpoints',
          'recovery-child',
          'checkpoint.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"recovered-after-partial-migration"');
    await expect(
      readFile(
        path.join(
          targetRoot,
          'sessions',
          '.checkpoints',
          'conflicting-target',
          'checkpoint.json',
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(targetRoot, 'archive', 'archived.json'), 'utf8'),
    ).resolves.toContain('"archived"');
    await expect(
      readFile(
        path.join(targetRoot, 'archive', '.checkpoints', 'archived', 'checkpoint.json'),
        'utf8',
      ),
    ).resolves.toContain('"archived-checkpoint"');
    await expect(
      readFile(path.join(targetRoot, 'agent-executions', 'matching-execution.json'), 'utf8'),
    ).resolves.toContain('"matching-execution"');
    await expect(
      readFile(path.join(targetRoot, 'tasks', 'matching-task.json'), 'utf8'),
    ).resolves.toContain('"matching-task"');
    await expect(
      readFile(path.join(targetRoot, 'tasks', 'child-task.json'), 'utf8'),
    ).resolves.toContain('"child-task"');

    for (const relativePath of [
      ['sessions', 'other.json'],
      ['sessions', 'unscoped.json'],
      ['sessions', '...json'],
      ['sessions', 'explicit-other-child.json'],
      ['agent-executions', 'other-execution.json'],
      ['tasks', 'other-task.json'],
      ['meta.json'],
      ['mailboxes'],
    ]) {
      await expect(
        readFile(path.join(targetRoot, ...relativePath), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(
      readFile(path.join(legacySessions, 'unscoped.json'), 'utf8'),
    ).resolves.toContain('"unscoped"');
    await expect(
      readFile(path.join(legacyRoot, 'meta.json'), 'utf8'),
    ).resolves.toContain('"in_progress"');

    await expect(
      migrateLegacyHadamardProjectData({
        homeDir,
        workDir,
        targetDirectory: targetRoot,
      }),
    ).resolves.toMatchObject({ total: 0 });

    const otherTargetRoot = getHadamardProjectSessionDirectory(otherWorkDir, homeDir);
    await expect(
      migrateLegacyHadamardProjectData({
        homeDir,
        workDir: otherWorkDir,
        targetDirectory: otherTargetRoot,
      }),
    ).resolves.toMatchObject({
      sessions: 2,
      agentExecutions: 1,
      backgroundTasks: 1,
      projectArtifacts: 0,
      total: 4,
    });
    await expect(
      readFile(path.join(otherTargetRoot, 'sessions', 'other.json'), 'utf8'),
    ).resolves.toContain('"other"');
    await expect(
      readFile(path.join(otherTargetRoot, 'sessions', 'explicit-other-child.json'), 'utf8'),
    ).resolves.toContain('"explicit-other-child"');
    await expect(
      readFile(path.join(otherTargetRoot, 'agent-executions', 'other-execution.json'), 'utf8'),
    ).resolves.toContain('"other-execution"');
    await expect(
      readFile(path.join(otherTargetRoot, 'tasks', 'other-task.json'), 'utf8'),
    ).resolves.toContain('"other-task"');
    for (const relativePath of [
      ['sessions', 'matching.json'],
      ['sessions', 'child.json'],
      ['agent-executions', 'matching-execution.json'],
      ['tasks', 'matching-task.json'],
    ]) {
      await expect(
        readFile(path.join(otherTargetRoot, ...relativePath), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('copies singleton project artifacts only when legacy ownership is unambiguous', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'unique-owner');
    const legacyKey = encodeHadamardProjectPath(workDir).replace(/--[0-9a-f]{24}$/u, '');
    const legacyRoot = path.join(homeDir, '.hadamard', 'projects', legacyKey);
    const targetRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
    await Promise.all([
      mkdir(path.join(legacyRoot, 'sessions'), { recursive: true }),
      mkdir(path.join(legacyRoot, 'mailboxes'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(legacyRoot, 'sessions', 'owned.json'),
        JSON.stringify({
          id: 'owned',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'meta.json'),
        JSON.stringify({ status: 'in_progress' }),
      ),
      writeFile(path.join(legacyRoot, 'workspace-note.txt'), 'legacy note'),
      writeFile(path.join(legacyRoot, 'mailboxes', 'inbox.json'), '{"items":[]}'),
    ]);

    await expect(
      migrateLegacyHadamardProjectData({
        homeDir,
        workDir,
        targetDirectory: targetRoot,
      }),
    ).resolves.toMatchObject({
      sessions: 1,
      projectArtifacts: 3,
      retainedUnassignedArtifacts: [],
      total: 4,
    });
    await expect(readFile(path.join(targetRoot, 'meta.json'), 'utf8'))
      .resolves.toContain('"in_progress"');
    await expect(readFile(path.join(targetRoot, 'workspace-note.txt'), 'utf8'))
      .resolves.toBe('legacy note');
    await expect(readFile(path.join(targetRoot, 'mailboxes', 'inbox.json'), 'utf8'))
      .resolves.toContain('"items"');
  });

  it('migrates delegated agent records owned by an external temporary worktree', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'worktree-owner');
    const temporaryWorktree = path.join(
      os.tmpdir(),
      'hadamard-worktree-migration',
      path.basename(homeDir),
    );
    const legacyKey = encodeHadamardProjectPath(workDir).replace(/--[0-9a-f]{24}$/u, '');
    const legacyRoot = path.join(homeDir, '.hadamard', 'projects', legacyKey);
    const targetRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
    await Promise.all([
      mkdir(path.join(legacyRoot, 'sessions'), { recursive: true }),
      mkdir(path.join(legacyRoot, 'agent-executions'), { recursive: true }),
      mkdir(path.join(legacyRoot, 'tasks'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(legacyRoot, 'sessions', 'root-session.json'),
        JSON.stringify({
          id: 'root-session',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'sessions', 'agent-session.json'),
        JSON.stringify({
          id: 'agent-session',
          kind: 'agent',
          parentSessionId: 'root-session',
          metadata: {
            __hadamardWorkDir: temporaryWorktree,
            __hadamardAgentWorktreePath: temporaryWorktree,
            __hadamardAgentDefinition: 'reviewer',
          },
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'agent-executions', 'agent-execution.json'),
        JSON.stringify({
          rootExecutionId: 'agent-execution',
          nodes: [{
            id: 'agent-execution',
            kind: 'root',
            sessionId: 'agent-session',
            cwd: temporaryWorktree,
          }],
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'tasks', 'agent-task.json'),
        JSON.stringify({
          id: 'agent-task',
          parentSessionId: 'root-session',
          sessionId: 'agent-session',
          executionId: 'agent-execution',
          workDir: temporaryWorktree,
          worktreePath: temporaryWorktree,
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'meta.json'),
        JSON.stringify({ status: 'in_progress' }),
      ),
    ]);

    await expect(
      migrateLegacyHadamardProjectData({
        homeDir,
        workDir,
        targetDirectory: targetRoot,
      }),
    ).resolves.toMatchObject({
      sessions: 2,
      agentExecutions: 1,
      backgroundTasks: 1,
      projectArtifacts: 1,
      retainedUnassignedArtifacts: [],
      total: 5,
    });
    await expect(
      readFile(path.join(targetRoot, 'sessions', 'agent-session.json'), 'utf8'),
    ).resolves.toContain('"agent-session"');
    await expect(
      readFile(
        path.join(targetRoot, 'agent-executions', 'agent-execution.json'),
        'utf8',
      ),
    ).resolves.toContain('"agent-execution"');
    await expect(
      readFile(path.join(targetRoot, 'tasks', 'agent-task.json'), 'utf8'),
    ).resolves.toContain('"agent-task"');
    await expect(
      readFile(path.join(targetRoot, 'meta.json'), 'utf8'),
    ).resolves.toContain('"in_progress"');
  });

  it('retains singleton artifacts for mixed-case legacy slug collisions on Windows', async () => {
    if (process.platform !== 'win32') return;

    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'Workspace', 'a-b');
    const otherWorkDir = path.join(homeDir, 'workspace', 'a_b');
    const legacyKey = encodeHadamardProjectPath(workDir).replace(/--[0-9a-f]{24}$/u, '');
    const legacyRoot = path.join(homeDir, '.hadamard', 'projects', legacyKey);
    const targetRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
    await mkdir(path.join(legacyRoot, 'sessions'), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(legacyRoot, 'sessions', 'owned.json'),
        JSON.stringify({
          id: 'owned',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'meta.json'),
        JSON.stringify({ status: 'in_progress' }),
      ),
      writeFile(
        path.join(homeDir, '.hadamard', 'workspaces.json'),
        JSON.stringify({
          workspaces: [
            { path: workDir },
            { path: otherWorkDir },
          ],
        }),
      ),
    ]);

    await expect(
      migrateLegacyHadamardProjectData({
        homeDir,
        workDir,
        targetDirectory: targetRoot,
      }),
    ).resolves.toMatchObject({
      sessions: 1,
      projectArtifacts: 0,
      retainedUnassignedArtifacts: ['meta.json'],
      total: 1,
    });
    await expect(readFile(path.join(targetRoot, 'meta.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not propagate ownerless records through colliding duplicate ids', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'same-id');
    const otherWorkDir = path.join(homeDir, 'workspace', 'same_id');
    const legacyKey = encodeHadamardProjectPath(workDir).replace(/--[0-9a-f]{24}$/u, '');
    const legacyRoot = path.join(homeDir, '.hadamard', 'projects', legacyKey);
    const sessionsDir = path.join(legacyRoot, 'sessions');
    const executionsDir = path.join(legacyRoot, 'agent-executions');
    const tasksDir = path.join(legacyRoot, 'tasks');
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(executionsDir, { recursive: true }),
      mkdir(tasksDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(sessionsDir, 'parent-a.json'),
        JSON.stringify({
          id: 'shared-parent',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(
        path.join(sessionsDir, 'parent-b.json'),
        JSON.stringify({
          id: 'shared-parent',
          metadata: { __hadamardWorkDir: otherWorkDir },
        }),
      ),
      writeFile(
        path.join(sessionsDir, 'ownerless-child.json'),
        JSON.stringify({
          id: 'ownerless-child',
          parentSessionId: 'shared-parent',
        }),
      ),
      writeFile(
        path.join(executionsDir, 'ownerless-execution.json'),
        JSON.stringify({
          rootExecutionId: 'ownerless-execution',
          nodes: [{
            id: 'ownerless-execution',
            kind: 'root',
            sessionId: 'shared-parent',
          }],
        }),
      ),
      writeFile(
        path.join(tasksDir, 'ownerless-task.json'),
        JSON.stringify({
          id: 'ownerless-task',
          sessionId: 'shared-parent',
          executionId: 'ownerless-execution',
        }),
      ),
    ]);

    for (const candidate of [workDir, otherWorkDir]) {
      const targetRoot = getHadamardProjectSessionDirectory(candidate, homeDir);
      await migrateLegacyHadamardProjectData({
        homeDir,
        workDir: candidate,
        targetDirectory: targetRoot,
      });
      await expect(
        readFile(path.join(targetRoot, 'sessions', 'ownerless-child.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(
          path.join(targetRoot, 'agent-executions', 'ownerless-execution.json'),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(path.join(targetRoot, 'tasks', 'ownerless-task.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('treats explicit cross-project owners and unreadable records as ambiguous', async () => {
    const homeDir = await createTempHome();
    const workDir = path.join(homeDir, 'workspace', 'explicit-owner');
    const otherWorkDir = path.join(homeDir, 'workspace', 'explicit_owner');
    const legacyKey = encodeHadamardProjectPath(workDir).replace(/--[0-9a-f]{24}$/u, '');
    const legacyRoot = path.join(homeDir, '.hadamard', 'projects', legacyKey);
    const sessionsDir = path.join(legacyRoot, 'sessions');
    const executionsDir = path.join(legacyRoot, 'agent-executions');
    const tasksDir = path.join(legacyRoot, 'tasks');
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(executionsDir, { recursive: true }),
      mkdir(tasksDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(sessionsDir, 'owned.json'),
        JSON.stringify({
          id: 'shared-session',
          metadata: { __hadamardWorkDir: workDir },
        }),
      ),
      writeFile(path.join(sessionsDir, 'unreadable.json'), '{'),
      writeFile(
        path.join(executionsDir, 'other-execution.json'),
        JSON.stringify({
          rootExecutionId: 'other-execution',
          nodes: [{
            id: 'other-execution',
            kind: 'root',
            sessionId: 'shared-session',
            cwd: otherWorkDir,
          }],
        }),
      ),
      writeFile(
        path.join(tasksDir, 'other-task.json'),
        JSON.stringify({
          id: 'other-task',
          sessionId: 'shared-session',
          workDir: otherWorkDir,
        }),
      ),
      writeFile(
        path.join(legacyRoot, 'meta.json'),
        JSON.stringify({ status: 'planning' }),
      ),
    ]);

    const targetRoot = getHadamardProjectSessionDirectory(workDir, homeDir);
    await expect(
      migrateLegacyHadamardProjectData({
        homeDir,
        workDir,
        targetDirectory: targetRoot,
      }),
    ).resolves.toMatchObject({
      sessions: 1,
      agentExecutions: 0,
      backgroundTasks: 0,
      projectArtifacts: 0,
      retainedUnassignedArtifacts: ['meta.json'],
      total: 1,
    });
    await expect(
      readFile(path.join(targetRoot, 'agent-executions', 'other-execution.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(targetRoot, 'tasks', 'other-task.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(targetRoot, 'meta.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves and validates the default reasoning effort', async () => {
    const homeDir = await createTempHome();
    const config = await resolveRuntimeConfig({
      homeDir,
      model: 'demo-model',
      authToken: 'test-token',
      effort: 'high',
    });
    expect(config.effort).toBe('high');

    await expect(
      resolveRuntimeConfig({
        homeDir,
        model: 'demo-model',
        authToken: 'test-token',
        effort: 'invalid' as never,
      }),
    ).rejects.toThrow('Invalid effort');
  });

  it('resolves neutral model tiers and defaults to medium', async () => {
    const homeDir = await createTempHome();
    const settingsPath = path.join(homeDir, 'tier-config.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          HADAMARD_AUTH_TOKEN: 'settings-token',
          HADAMARD_DEFAULT_MIN_MODEL: 'small-model',
          HADAMARD_DEFAULT_MEDIUM_MODEL: 'balanced-model',
          HADAMARD_DEFAULT_MAX_MODEL: 'large-model',
        },
      }),
      'utf8',
    );
    await loadJsonConfigFile(settingsPath);

    const defaulted = await resolveRuntimeConfig({ homeDir });
    const explicitTier = await resolveRuntimeConfig({ homeDir, model: 'max' });

    expect(defaulted.model).toBe('balanced-model');
    expect(defaulted.modelTier).toBe('medium');
    expect(explicitTier.model).toBe('large-model');
    expect(explicitTier.modelTier).toBe('max');
    expect(defaulted.modelTiers).toEqual({
      min: 'small-model',
      medium: 'balanced-model',
      max: 'large-model',
    });
  });

  it('defaults maxToolIterations to unlimited and honors an explicit cap', async () => {
    const homeDir = await createTempHome();

    const defaulted = await resolveRuntimeConfig({
      homeDir,
      model: 'demo-model',
      authToken: 'test-token',
    });
    expect(defaulted.maxToolIterations).toBe(Number.POSITIVE_INFINITY);

    const capped = await resolveRuntimeConfig({
      homeDir,
      model: 'demo-model',
      authToken: 'test-token',
      maxToolIterations: 24,
    });
    expect(capped.maxToolIterations).toBe(24);
  });

  it('derives compact budgets from the selected model catalog entry', async () => {
    const homeDir = await createTempHome();
    addBridgeConfig({
      name: 'large-context',
      runtime: 'hadamard',
      execution: 'api',
      provider: 'anthropic',
      model: 'large-context-model',
      models: [{
        name: 'large-context-model',
        contextWindowTokens: 1_000_000,
        effectiveContextWindowPercent: 95,
      }],
    }, homeDir);
    const config = await resolveRuntimeConfig({
      homeDir,
      model: 'large-context-model',
      authToken: 'test-token',
    });
    expect(config.compact).toMatchObject({
      contextWindowTokens: 1_000_000,
      effectiveContextWindowPercent: 95,
      contextWindowSource: 'model_catalog',
    });
  });

  it('requires an explicit or tiered model for the anthropic protocol', async () => {
    const homeDir = await createTempHome();

    await expect(
      resolveRuntimeConfig({
        homeDir,
        authToken: 'test-token',
      }),
    ).rejects.toThrow('No model was configured');
  });

  it('resolves runtime config from process environment variables', async () => {
    const homeDir = await createTempHome();
    const previous = {
      token: process.env.HADAMARD_AUTH_TOKEN,
      provider: process.env.HADAMARD_PROVIDER,
      model: process.env.HADAMARD_MODEL,
      baseURL: process.env.HADAMARD_BASE_URL,
    };

    process.env.HADAMARD_AUTH_TOKEN = 'env-token';
    process.env.HADAMARD_PROVIDER = 'openai';
    process.env.HADAMARD_MODEL = 'env-model';
    process.env.HADAMARD_BASE_URL = 'https://example.test/env';

    try {
      const config = await resolveRuntimeConfig({ homeDir });

      expect(config.authToken).toBe('env-token');
      expect(config.provider).toBe('openai');
      expect(config.model).toBe('env-model');
      expect(config.baseURL).toBe('https://example.test/env');
    } finally {
      if (previous.token === undefined) delete process.env.HADAMARD_AUTH_TOKEN;
      else process.env.HADAMARD_AUTH_TOKEN = previous.token;
      if (previous.provider === undefined) delete process.env.HADAMARD_PROVIDER;
      else process.env.HADAMARD_PROVIDER = previous.provider;
      if (previous.model === undefined) delete process.env.HADAMARD_MODEL;
      else process.env.HADAMARD_MODEL = previous.model;
      if (previous.baseURL === undefined) delete process.env.HADAMARD_BASE_URL;
      else process.env.HADAMARD_BASE_URL = previous.baseURL;
    }
  });

  it('loads the default Hadamard settings from ~/.hadamard/settings.json only', async () => {
    const homeDir = await createTempHome();
    const hadamardDir = path.join(homeDir, '.hadamard');
    const settingsPath = path.join(hadamardDir, 'settings.json');

    await mkdir(hadamardDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            HADAMARD_AUTH_TOKEN: 'bridge-token',
            HADAMARD_BASE_URL: 'https://example.test/runtime',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const settings = await loadDefaultHadamardSettings({ homeDir });

    expect(settings.path).toBe(settingsPath);
    expect(settings.env.HADAMARD_AUTH_TOKEN).toBe('bridge-token');
  });
});
