import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHadamardMemoryApi } from '../src/index.js';

const tempDirs: string[] = [];
const originalConfigDir = process.env.HADAMARD_CONFIG_DIR;

afterEach(async () => {
  if (originalConfigDir == null) {
    delete process.env.HADAMARD_CONFIG_DIR;
  } else {
    process.env.HADAMARD_CONFIG_DIR = originalConfigDir;
  }

  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Hadamard memory helpers', () => {
  it('injects only memory_summary.md into the system prompt entrypoints', async () => {
    const tempDir = await createTempDir('hadamard-memory-');
    process.env.HADAMARD_CONFIG_DIR = path.join(tempDir, '.hadamard');

    const projectPath = path.join(tempDir, 'workspace');
    const configPath = path.join(tempDir, 'settings.json');
    const sessionId = 'memory-session';

    await mkdir(projectPath, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          autoCompactEnabled: true,
          autoMemoryEnabled: true,
          autoDreamEnabled: false,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const memory = createHadamardMemoryApi({
      configPath,
      homeDir: tempDir,
      projectPath,
      sessionId,
    });

    const paths = await memory.paths();
    await mkdir(paths.autoMemoryDir, { recursive: true });
    await writeFile(
      paths.autoMemoryEntrypoint,
      '# MEMORY\n\n## User preferences\n\nPrefers concise technical summaries.\n',
      'utf8',
    );
    await writeFile(
      path.join(paths.autoMemoryDir, 'memory_summary.md'),
      [
        '# Summary map',
        '',
        '- Preferences: concise summaries — MEMORY.md §User preferences (lines ~3-5)',
      ].join('\n'),
      'utf8',
    );

    const prompt = await memory.buildCombinedPrompt();
    const promptWithEntrypoints = await memory.buildPromptWithEntrypoints();
    const surfaced = await memory.surfaceRelevantMemories('how should I tag a release?');

    expect(paths.autoMemoryDir).toContain(path.join('.hadamard', 'projects'));
    expect(paths.sessionId).toBe(sessionId);
    expect(prompt).toContain(paths.autoMemoryDir);
    expect(prompt).toContain(paths.autoMemoryEntrypoint);
    expect(prompt).not.toContain('Session Memory');
    expect(promptWithEntrypoints).toContain('memory_summary.md');
    expect(promptWithEntrypoints).toContain('Preferences: concise summaries');
    // MEMORY.md body is not auto-injected; agent must Read it.
    expect(promptWithEntrypoints).not.toContain('Prefers concise technical summaries.');
    expect(surfaced).toEqual([]);

    const updatedSettings = await memory.updateSettings({
      autoDreamEnabled: true,
      autoMemoryDirectory: '~/custom-memory',
    });
    const state = await memory.state({
      includeCombinedPrompt: true,
    });

    expect(updatedSettings.autoDreamEnabled).toBe(true);
    expect(updatedSettings.autoMemoryDirectory).toBe('~/custom-memory');
    expect(state.enabled).toEqual({
      autoCompact: true,
      autoMemory: true,
      autoDream: true,
    });
    expect(state.paths.autoMemoryDir).toBe(path.join(tempDir, '.hadamard', 'custom-memory'));
  });

  it('returns default compact state when no bridge transcripts are available', async () => {
    const tempDir = await createTempDir('hadamard-memory-boundary-');
    process.env.HADAMARD_CONFIG_DIR = path.join(tempDir, '.hadamard');

    const projectPath = path.join(tempDir, 'workspace');
    const memory = createHadamardMemoryApi({
      homeDir: tempDir,
      projectPath,
    });
    const paths = await memory.paths();
    const sessionId = 'boundary-session';
    const sessionFile = path.join(paths.projectStateDir, `${sessionId}.jsonl`);

    await mkdir(paths.projectStateDir, { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          parentUuid: null,
          timestamp: '2026-04-01T00:00:00.000Z',
          sessionId,
          cwd: projectPath,
          message: { content: 'hello' },
        }),
      ].join('\n'),
      'utf8',
    );

    const compactState = await memory.compactState({
      sessionId,
      includeBoundaries: true,
    });

    expect(compactState).toMatchObject({
      compactCount: 0,
      microcompactCount: 0,
      hasCompacted: false,
      lastSummarizedMessageUuid: undefined,
      latestPreservedSegment: undefined,
    });
    expect(compactState.boundaries).toBeUndefined();
    expect(compactState.latestBoundary).toBeUndefined();
    expect(compactState.transcriptPath).toContain(`${sessionId}.jsonl`);
  });

  it('browses durable MEMORY.md and summary from the current project', async () => {
    const tempDir = await createTempDir('hadamard-memory-browser-');
    process.env.HADAMARD_CONFIG_DIR = path.join(tempDir, '.hadamard');
    const projectPath = path.join(tempDir, 'workspace');
    const memory = createHadamardMemoryApi({ homeDir: tempDir, projectPath, sessionId: 'current' });
    const paths = await memory.paths();

    await mkdir(paths.autoMemoryDir, { recursive: true });
    await writeFile(path.join(paths.autoMemoryDir, 'memory_summary.md'), '# Summary\nRelease trains are weekly.\n', 'utf8');
    await writeFile(paths.autoMemoryEntrypoint, '# MEMORY\n\n## Status\nUse signed tags.\n', 'utf8');

    const entries = await memory.listMemoryContent();
    expect(entries.map(entry => entry.id)).toEqual(expect.arrayContaining([
      'durable:memory_summary.md',
      'durable:MEMORY.md',
    ]));

    const found = await memory.searchMemoryContent('signed tags');
    expect(found).toHaveLength(1);
    const shown = await memory.readMemoryContent(found[0]!.entry.id);
    expect(shown.content).toContain('Use signed tags.');
    await expect(memory.readMemoryContent(path.join(tempDir, 'outside.md')))
      .rejects.toThrow('current project');
  });
});
