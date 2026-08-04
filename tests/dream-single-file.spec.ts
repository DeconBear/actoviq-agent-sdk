import { mkdir, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHadamardDreamPrompt,
  deleteLegacyDreamArtifacts,
  toDreamPaths,
} from '../src/memory/hadamardDream.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Dream single-file consolidation helpers', () => {
  it('builds a prompt that points at transcripts and only two write targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-dream-prompt-'));
    tempDirs.push(root);
    const paths = toDreamPaths({
      projectStateDir: path.join(root, 'state'),
      autoMemoryDir: path.join(root, 'memory'),
      teamMemoryDir: path.join(root, 'memory', 'team'),
      autoMemoryEntrypoint: path.join(root, 'memory', 'MEMORY.md'),
      teamMemoryEntrypoint: path.join(root, 'memory', 'team', 'MEMORY.md'),
    }, path.join(root, 'sessions'));

    const prompt = buildHadamardDreamPrompt(paths, ['sess-a', 'sess-b']);
    expect(prompt).toContain(paths.memoryEntrypoint);
    expect(prompt).toContain(paths.memorySummaryPath);
    expect(prompt).toContain(path.join(paths.transcriptDir, 'sess-a.jsonl'));
    expect(prompt).toContain('Do NOT create topics/');
    expect(prompt).not.toContain('raw_memories.md and the changed rollout');
  });

  it('deletes legacy multi-file Dream artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-dream-legacy-'));
    tempDirs.push(root);
    const memoryDir = path.join(root, 'memory');
    const paths = toDreamPaths({
      projectStateDir: path.join(root, 'state'),
      autoMemoryDir: memoryDir,
      teamMemoryDir: path.join(memoryDir, 'team'),
      autoMemoryEntrypoint: path.join(memoryDir, 'MEMORY.md'),
      teamMemoryEntrypoint: path.join(memoryDir, 'team', 'MEMORY.md'),
    }, path.join(root, 'sessions'));

    await mkdir(path.join(memoryDir, 'topics'), { recursive: true });
    await mkdir(paths.rolloutSummariesDir, { recursive: true });
    await writeFile(paths.rawMemoriesPath, 'legacy\n', 'utf8');
    await writeFile(path.join(memoryDir, 'topics', 'x.md'), 'topic\n', 'utf8');
    await writeFile(path.join(paths.rolloutSummariesDir, 'a.md'), 'rollout\n', 'utf8');
    await writeFile(paths.memoryEntrypoint, '# keep\n', 'utf8');

    await deleteLegacyDreamArtifacts(paths);

    await expect(access(paths.rawMemoriesPath)).rejects.toBeTruthy();
    await expect(access(paths.rolloutSummariesDir)).rejects.toBeTruthy();
    await expect(access(path.join(memoryDir, 'topics'))).rejects.toBeTruthy();
    await expect(access(paths.memoryEntrypoint)).resolves.toBeUndefined();
  });
});
