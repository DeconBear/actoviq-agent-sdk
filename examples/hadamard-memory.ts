import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createHadamardMemoryApi } from 'actoviq-agent-sdk';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-memory-example-'));
const projectDir = path.join(tempDir, 'workspace');
const configPath = path.join(tempDir, 'settings.json');
const sessionId = 'memory-demo-session';

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
  projectPath: projectDir,
  sessionId,
});

try {
  const paths = await memory.paths();
  const settings = await memory.getSettings();
  const prompt = await memory.buildCombinedPrompt();
  await mkdir(paths.autoMemoryDir, { recursive: true });
  await mkdir(paths.teamMemoryDir, { recursive: true });
  await writeFile(
    paths.autoMemoryEntrypoint,
    '- [Coding Style](coding-style.md) - Prefer small, reviewable changes with tests.\n',
    'utf8',
  );
  await writeFile(
    path.join(paths.autoMemoryDir, 'coding-style.md'),
    [
      '---',
      'type: reference',
      'description: Preferred coding and review workflow for this repository',
      '---',
      '',
      'Keep changes small, add focused tests, and explain tradeoffs clearly.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    paths.teamMemoryEntrypoint,
    '- [Release Flow](release-flow.md) - Bump package version before tagging releases.\n',
    'utf8',
  );
  await writeFile(
    path.join(paths.teamMemoryDir, 'release-flow.md'),
    [
      '---',
      'type: project',
      'description: Release checklist for npm and GitHub tags',
      '---',
      '',
      'Always bump package.json before pushing a release tag.',
    ].join('\n'),
    'utf8',
  );
  const compactState = await memory.compactState({
    sessionId,
    runtimeState: {
      initialized: true,
      tokensAtLastExtraction: 11_000,
      lastMessageCountAtExtraction: 4,
      extractionCount: 0,
      pendingPostCompaction: false,
    },
  });
  const manifest = await memory.formatMemoryManifest();
  const relevantMemories = await memory.findRelevantMemories('how should I release this package?', {
    recentTools: ['npm publish'],
  });
  const surfacedMemories = await memory.surfaceRelevantMemories(
    'how should I release this package?',
    {
      recentTools: ['npm publish'],
    },
  );

  console.log('Paths:', paths);
  console.log('Settings:', settings);
  console.log('Compact state:', {
    hasCompacted: compactState.hasCompacted,
    pendingPostCompaction: compactState.pendingPostCompaction,
    runtimeState: compactState.runtimeState,
  });
  console.log('Prompt preview:', prompt.slice(0, 300));
  console.log(
    'Prompt with entrypoints preview:',
    (await memory.buildPromptWithEntrypoints()).slice(0, 300),
  );
  console.log('Memory manifest:', manifest);
  console.log('Relevant memories:', relevantMemories);
  console.log('Surfaced memories:', surfacedMemories);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
