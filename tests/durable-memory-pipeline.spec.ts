import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  completeDurableMemoryConsolidation,
  prepareDurableMemoryConsolidation,
} from '../src/memory/durableMemoryPipeline.js';
import type { HadamardDreamPaths, StoredSession } from '../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Durable Memory two-phase pipeline', () => {
  it('extracts idle append-only transcripts, redacts secrets, and consolidates stable artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-durable-memory-'));
    roots.push(root);
    const projectPath = path.join(root, 'project-a');
    const projectStateDir = path.join(root, 'state-a');
    const memoryDir = path.join(projectStateDir, 'memory');
    await Promise.all([mkdir(projectPath), mkdir(memoryDir, { recursive: true })]);
    const paths = dreamPaths(projectStateDir, memoryDir);
    const session = storedSession('session-one', projectPath, 13);
    await writeFile(
      path.join(projectStateDir, 'session-one.jsonl'),
      `${JSON.stringify({ message: { role: 'user', content: 'Keep the release checklist. token=super-secret-value' } })}\n`,
      'utf8',
    );

    const prepared = await prepareDurableMemoryConsolidation({
      paths,
      projectPath,
      sessions: [session],
      currentSessionId: 'current-session',
      config: {
        minHours: 0,
        minSessions: 1,
        scanIntervalMs: 0,
        minRolloutIdleHours: 12,
        maxRolloutAgeDays: 30,
        maxRolloutsPerStartup: 6,
      },
      maxInputTokens: 20_000,
      extract: async ({ transcript }) => {
        expect(transcript).toContain('release checklist');
        return {
          rawMemory: 'Release checklist is durable. token=super-secret-value',
          rolloutSummary: 'Established the release checklist.',
          rolloutSlug: 'release-process',
          noOutput: false,
        };
      },
    });

    expect(prepared).toMatchObject({ changed: true, extractedSessionIds: ['session-one'] });
    expect(await readFile(paths.rawMemoriesPath, 'utf8')).toContain('token=[REDACTED_SECRET]');
    expect(await readFile(path.join(paths.rolloutSummariesDir, 'release-process.md'), 'utf8'))
      .toContain('Established the release checklist.');
    await completeDurableMemoryConsolidation({ paths, prepared: prepared!, success: true });

    const unchanged = await prepareDurableMemoryConsolidation({
      paths,
      projectPath,
      sessions: [session],
      currentSessionId: 'current-session',
      config: {
        minHours: 0,
        minSessions: 1,
        scanIntervalMs: 0,
        minRolloutIdleHours: 12,
        maxRolloutAgeDays: 30,
        maxRolloutsPerStartup: 6,
      },
      maxInputTokens: 20_000,
      extract: async () => {
        throw new Error('unchanged transcripts must not be extracted twice');
      },
    });
    expect(unchanged).toMatchObject({ changed: false, extractedSessionIds: [] });
    await completeDurableMemoryConsolidation({ paths, prepared: unchanged!, success: true });
  });

  it('keeps project state and artifacts isolated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-durable-isolation-'));
    roots.push(root);
    const first = dreamPaths(path.join(root, 'state-a'), path.join(root, 'state-a', 'memory'));
    const second = dreamPaths(path.join(root, 'state-b'), path.join(root, 'state-b', 'memory'));
    await mkdir(first.memoryDir, { recursive: true });
    await mkdir(second.memoryDir, { recursive: true });
    await writeFile(first.rawMemoriesPath, '# first project\n', 'utf8');
    await expect(readFile(second.rawMemoriesPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(first.stateDbPath).not.toBe(second.stateDbPath);
  });

  it('keeps one rollout summary per session when model slugs collide', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-durable-slugs-'));
    roots.push(root);
    const projectPath = path.join(root, 'project');
    const projectStateDir = path.join(root, 'state');
    const paths = dreamPaths(projectStateDir, path.join(projectStateDir, 'memory'));
    await Promise.all([mkdir(projectPath), mkdir(paths.memoryDir, { recursive: true })]);
    for (const id of ['first', 'second']) {
      await writeFile(path.join(projectStateDir, `${id}.jsonl`), `${JSON.stringify({ message: id })}\n`, 'utf8');
    }

    const prepared = await prepareDurableMemoryConsolidation({
      paths,
      projectPath,
      sessions: [storedSession('first', projectPath, 13), storedSession('second', projectPath, 14)],
      currentSessionId: 'current',
      config: {
        minHours: 0,
        minSessions: 1,
        scanIntervalMs: 0,
        minRolloutIdleHours: 12,
        maxRolloutAgeDays: 30,
        maxRolloutsPerStartup: 6,
      },
      maxInputTokens: 20_000,
      extract: async ({ session }) => ({
        rawMemory: `Memory for ${session.id}`,
        rolloutSummary: `Summary for ${session.id}`,
        rolloutSlug: 'same-topic',
        noOutput: false,
      }),
    });

    expect(prepared?.selectedSessionIds).toHaveLength(2);
    expect((await readdir(paths.rolloutSummariesDir)).filter(name => name.endsWith('.md')))
      .toHaveLength(2);
    await completeDurableMemoryConsolidation({ paths, prepared: prepared!, success: true });
  });
});

function dreamPaths(projectStateDir: string, memoryDir: string): HadamardDreamPaths {
  return {
    memoryDir,
    teamMemoryDir: path.join(memoryDir, 'team'),
    memoryEntrypoint: path.join(memoryDir, 'MEMORY.md'),
    teamMemoryEntrypoint: path.join(memoryDir, 'team', 'MEMORY.md'),
    transcriptDir: projectStateDir,
    lockPath: path.join(memoryDir, '.consolidate-lock'),
    stateDbPath: path.join(projectStateDir, 'memory-state.sqlite'),
    rawMemoriesPath: path.join(memoryDir, 'raw_memories.md'),
    rolloutSummariesDir: path.join(memoryDir, 'rollout_summaries'),
    memorySummaryPath: path.join(memoryDir, 'memory_summary.md'),
  };
}

function storedSession(id: string, workDir: string, idleHours: number): StoredSession {
  const touched = new Date(Date.now() - idleHours * 60 * 60 * 1000).toISOString();
  return {
    version: 1,
    revision: 0,
    id,
    title: id,
    titleSource: 'manual',
    model: 'test-model',
    tags: [],
    metadata: { __hadamardWorkDir: workDir },
    createdAt: touched,
    updatedAt: touched,
    lastRunAt: touched,
    lastActiveAt: touched,
    status: 'idle',
    messages: [],
    runs: [],
    kind: 'main',
  };
}
