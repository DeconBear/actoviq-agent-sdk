import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
import { getActoviqProjectSessionDirectory, SessionStore } from '../src/index.js';
import { AgentExecutionStore } from '../src/storage/agentExecutionStore.js';
import { BackgroundTaskStore } from '../src/storage/backgroundTaskStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createWorkspace(root: string, name: string): Promise<string> {
  const workspace = path.join(root, name);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

describe('GUI session cleanup', () => {
  it('auto-cleans empty sessions when state is recomputed, keeping non-empty ones', async () => {
    const root = await tempDir('actoviq-gui-acln-');
    const homeDir = path.join(root, 'home');
    const workA = await createWorkspace(root, 'work-a');

    // Pre-seed: one empty session + one non-empty session.
    const projectRoot = getActoviqProjectSessionDirectory(workA, homeDir);
    const store = new SessionStore(projectRoot);
    await store.create({ id: 'empty-a', metadata: { __actoviqWorkDir: workA } });
    await store.create({
      id: 'keep-a',
      metadata: { __actoviqWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'keep me' }],
    });
    const unsafeHistoricalFile = path.join(projectRoot, 'sessions', '...json');
    await writeFile(unsafeHistoricalFile, JSON.stringify({
      id: 'unsafe-historical',
      metadata: { __actoviqWorkDir: workA },
      messages: [],
    }), 'utf8');

    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const port = 45000 + Math.floor(Math.random() * 10000);
    const server = await startActoviqGuiServer({
      workDir: workA,
      homeDir,
      host: '127.0.0.1',
      port,
      configPath,
    });
    const authHeaders = { 'x-actoviq-token': server.token };
    try {
      // The first /api/state call recomputes the heavy cache → auto-cleans
      // empty sessions (except the active one, which is the server's own fresh
      // 0-message session, excluded from cleanup).
      const state = await fetch(`${server.url}api/state`, { headers: authHeaders })
        .then((res) => res.json()) as {
          projects: Array<{ path: string; sessionCount: number }>;
        };

      // hiddenEmptySessionCount is no longer in the state — auto-clean has
      // already removed orphaned empty sessions.
      expect(state).toHaveProperty('projects');
      expect(state).not.toHaveProperty('hiddenEmptySessionCount');

      // The empty session should be gone from disk.
      await expect(store.load('empty-a')).rejects.toThrow();
      // The non-empty session must survive.
      expect((await store.load('keep-a')).messages).toHaveLength(1);
      // A malformed legacy filename must never turn ".." into a recursive
      // checkpoint cleanup of the whole sessions directory.
      await expect(readFile(unsafeHistoricalFile, 'utf8')).resolves.toContain(
        '"unsafe-historical"',
      );
    } finally {
      await server.close();
    }
  });

  it('keeps agent and active runtime sessions and hides archived legacy agents', async () => {
    const root = await tempDir('actoviq-gui-agent-cleanup-');
    const homeDir = path.join(root, 'home');
    const workA = await createWorkspace(root, 'work-a');
    const projectRoot = getActoviqProjectSessionDirectory(workA, homeDir);
    const store = new SessionStore(projectRoot);

    await store.create({
      id: 'parent-a',
      metadata: { __actoviqWorkDir: workA },
      initialMessages: [{ role: 'user', content: 'parent conversation' }],
    });
    await store.create({
      id: 'agent-a',
      kind: 'agent',
      parentSessionId: 'parent-a',
      metadata: { __actoviqWorkDir: workA },
    });
    await store.create({
      id: 'legacy-agent-a',
      metadata: {
        __actoviqWorkDir: workA,
        __actoviqAgentDefinition: 'legacy-reviewer',
      },
    });
    await store.create({
      id: 'execution-ref-a',
      metadata: { __actoviqWorkDir: workA },
    });
    await store.create({
      id: 'background-ref-a',
      metadata: { __actoviqWorkDir: workA },
    });
    await store.create({
      id: 'unreferenced-a',
      metadata: { __actoviqWorkDir: workA },
    });

    const at = new Date(Date.UTC(2026, 6, 17, 0, 0, 0)).toISOString();
    await new AgentExecutionStore(projectRoot).upsertEvent({
      type: 'thread.started',
      eventId: 'cleanup-execution-started',
      rootExecutionId: 'cleanup-execution',
      occurredAt: at,
      executionId: 'cleanup-execution',
      sessionId: 'execution-ref-a',
      agentName: 'Cleanup race agent',
      runtime: 'hadamard',
      cwd: workA,
      agentStatus: 'running',
      threadStatus: 'active',
    });

    const archiveDir = path.join(projectRoot, 'archive');
    await mkdir(archiveDir, { recursive: true });
    const archivedBase = {
      titleSource: 'auto',
      model: 'test-model',
      createdAt: at,
      updatedAt: at,
      status: 'idle',
      tags: [],
      messages: [{ role: 'user', content: 'archived conversation' }],
      runs: [],
    };
    await Promise.all([
      writeFile(path.join(archiveDir, 'archived-main.json'), JSON.stringify({
        ...archivedBase,
        id: 'archived-main',
        title: 'Archived main',
        metadata: { __actoviqWorkDir: workA },
      }), 'utf8'),
      writeFile(path.join(archiveDir, 'archived-legacy-agent.json'), JSON.stringify({
        ...archivedBase,
        id: 'archived-legacy-agent',
        title: 'Archived legacy agent',
        metadata: {
          __actoviqWorkDir: workA,
          __actoviqAgentDefinition: 'legacy-reviewer',
        },
      }), 'utf8'),
    ]);

    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const server = await startActoviqGuiServer({
      workDir: workA,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
      configPath,
    });
    try {
      await new BackgroundTaskStore(projectRoot).create({
        status: 'queued',
        description: 'Protect a child session during background startup.',
        subagentType: 'reviewer',
        outputFile: path.join(projectRoot, 'background-ref.txt'),
        workDir: workA,
        createdAt: at,
        updatedAt: at,
        parentSessionId: 'parent-a',
        sessionId: 'background-ref-a',
      });

      const state = await fetch(`${server.url}api/state`, {
        headers: { 'x-actoviq-token': server.token },
      }).then(res => res.json()) as {
        sessions: Array<{ id: string }>;
        archivedSessions: Array<{ id: string }>;
      };

      expect(state.sessions.map(item => item.id)).toContain('parent-a');
      expect(state.archivedSessions.map(item => item.id)).toContain('archived-main');
      expect(state.archivedSessions.map(item => item.id)).not.toContain('archived-legacy-agent');
      await expect(store.load('unreferenced-a')).rejects.toThrow();
      expect((await store.load('agent-a')).kind).toBe('agent');
      await expect(store.load('legacy-agent-a')).resolves.toBeDefined();
      expect((await store.list()).find(item => item.id === 'legacy-agent-a')?.kind).toBe('agent');
      await expect(store.load('execution-ref-a')).resolves.toBeDefined();
      await expect(store.load('background-ref-a')).resolves.toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('fails closed when runtime protection state cannot be read', async () => {
    const root = await tempDir('actoviq-gui-cleanup-fail-closed-');
    const homeDir = path.join(root, 'home');
    const workA = await createWorkspace(root, 'work-a');
    const projectRoot = getActoviqProjectSessionDirectory(workA, homeDir);
    const store = new SessionStore(projectRoot);
    await store.create({
      id: 'must-survive',
      metadata: { __actoviqWorkDir: workA },
    });

    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const server = await startActoviqGuiServer({
      workDir: workA,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
      configPath,
    });
    try {
      await mkdir(path.join(projectRoot, 'tasks'), { recursive: true });
      await writeFile(path.join(projectRoot, 'tasks', 'corrupt.json'), '{', 'utf8');
      await fetch(`${server.url}api/state`, {
        headers: { 'x-actoviq-token': server.token },
      });
      await expect(store.load('must-survive')).resolves.toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('fails closed when Agent execution state is unreadable', async () => {
    const root = await tempDir('actoviq-gui-execution-cleanup-fail-closed-');
    const homeDir = path.join(root, 'home');
    const workA = await createWorkspace(root, 'work-a');
    const projectRoot = getActoviqProjectSessionDirectory(workA, homeDir);
    const store = new SessionStore(projectRoot);
    await store.create({
      id: 'execution-protected',
      metadata: { __actoviqWorkDir: workA },
    });

    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const server = await startActoviqGuiServer({
      workDir: workA,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
      configPath,
    });
    try {
      await mkdir(path.join(projectRoot, 'agent-executions'), { recursive: true });
      await writeFile(
        path.join(projectRoot, 'agent-executions', 'corrupt.json'),
        '{',
        'utf8',
      );
      await fetch(`${server.url}api/state`, {
        headers: { 'x-actoviq-token': server.token },
      });
      await expect(store.load('execution-protected')).resolves.toBeDefined();
    } finally {
      await server.close();
    }
  });
});
