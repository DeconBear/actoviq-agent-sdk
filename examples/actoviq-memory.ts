import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createActoviqMemoryApi } from 'actoviq-agent-sdk';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-memory-example-'));
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

const memory = createActoviqMemoryApi({
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
    paths.teamMemoryEntrypoint,
    '- [Release Flow](release-flow.md) - Bump package version before tagging releases.\n',
    'utf8',
  );
  await mkdir(paths.sessionMemoryDir!, { recursive: true });
  await writeFile(
    paths.sessionMemoryPath!,
    [
      '# Session Title',
      '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
      '',
      'Memory demo session',
      '',
      '# Current State',
      '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
      '',
      'Testing the Actoviq memory and compact helpers.',
    ].join('\n'),
    'utf8',
  );
  const compactState = await memory.compactState({
    includeSessionMemory: true,
    includeSummaryMessage: true,
    currentTokenCount: 18_000,
    tokensAtLastExtraction: 11_000,
    initialized: true,
    toolCallsSinceLastUpdate: 4,
  });

  console.log('Paths:', paths);
  console.log('Settings:', settings);
  console.log('Session memory defaults:', memory.getSessionMemoryConfig());
  console.log('Compact defaults:', memory.getSessionMemoryCompactConfig());
  console.log('Compact state:', {
    canUseSessionMemoryCompaction: compactState.canUseSessionMemoryCompaction,
    hasCompacted: compactState.hasCompacted,
    progress: compactState.progress,
  });
  console.log('Prompt preview:', prompt.slice(0, 300));
  console.log(
    'Prompt with entrypoints preview:',
    (await memory.buildPromptWithEntrypoints()).slice(0, 300),
  );
  console.log('Compact summary preview:', compactState.summaryMessage?.slice(0, 300));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
