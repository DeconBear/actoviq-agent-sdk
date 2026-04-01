import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createActoviqMemoryApi,
  getActoviqBridgeCompactBoundaries,
  getActoviqBridgeLatestCompactBoundary,
  getActoviqDefaultSessionMemoryTemplate,
} from '../src/index.js';

const tempDirs: string[] = [];
const originalConfigDir = process.env.ACTOVIQ_CONFIG_DIR;

afterEach(async () => {
  if (originalConfigDir == null) {
    delete process.env.ACTOVIQ_CONFIG_DIR;
  } else {
    process.env.ACTOVIQ_CONFIG_DIR = originalConfigDir;
  }

  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Actoviq memory helpers', () => {
  it('resolves memory paths, updates settings, and reads session memory', async () => {
    const tempDir = await createTempDir('actoviq-memory-');
    process.env.ACTOVIQ_CONFIG_DIR = path.join(tempDir, '.actoviq');

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

    const memory = createActoviqMemoryApi({
      configPath,
      homeDir: tempDir,
      projectPath,
      sessionId,
    });

    const paths = await memory.paths();
    await mkdir(paths.autoMemoryDir, { recursive: true });
    await mkdir(paths.teamMemoryDir, { recursive: true });
    await mkdir(paths.sessionMemoryDir!, { recursive: true });
    await writeFile(
      paths.autoMemoryEntrypoint,
      '- [User Prefs](user-prefs.md) - Prefers concise technical summaries.\n',
      'utf8',
    );
    await writeFile(
      paths.teamMemoryEntrypoint,
      '- [Workflow](workflow.md) - Run tests before opening a PR.\n',
      'utf8',
    );
    await writeFile(paths.sessionMemoryPath!, `${getActoviqDefaultSessionMemoryTemplate()}\n`, 'utf8');

    const prompt = await memory.buildCombinedPrompt();
    const promptWithEntrypoints = await memory.buildPromptWithEntrypoints();
    const updatedSettings = await memory.updateSettings({
      autoDreamEnabled: true,
      autoMemoryDirectory: '~/custom-memory',
    });
    const progress = memory.evaluateSessionMemoryProgress({
      currentTokenCount: 18_000,
      tokensAtLastExtraction: 11_000,
      initialized: true,
      toolCallsSinceLastUpdate: 4,
    });
    const state = await memory.state({
      includeCombinedPrompt: true,
      includeSessionMemory: true,
      includeSessionPrompt: true,
      includeSessionTemplate: true,
    });

    expect(paths.autoMemoryDir).toContain(path.join('.actoviq', 'projects'));
    expect(paths.sessionMemoryPath).toContain(path.join(sessionId, 'session-memory', 'summary.md'));
    expect(prompt).toContain(paths.autoMemoryDir);
    expect(prompt).toContain(paths.teamMemoryDir);
    expect(promptWithEntrypoints).toContain(paths.autoMemoryEntrypoint);
    expect(promptWithEntrypoints).toContain('Prefers concise technical summaries');
    expect(promptWithEntrypoints).toContain('Run tests before opening a PR');
    expect(updatedSettings.autoDreamEnabled).toBe(true);
    expect(updatedSettings.autoMemoryDirectory).toBe('~/custom-memory');
    expect(memory.getSessionMemoryConfig()).toEqual({
      minimumMessageTokensToInit: 10_000,
      minimumTokensBetweenUpdate: 5_000,
      toolCallsBetweenUpdates: 3,
    });
    expect(memory.getSessionMemoryCompactConfig()).toEqual({
      minTokens: 10_000,
      minTextBlockMessages: 5,
      maxTokens: 40_000,
    });
    expect(progress).toMatchObject({
      initialized: true,
      tokensSinceLastExtraction: 7_000,
      meetsUpdateThreshold: true,
      meetsToolCallThreshold: true,
      shouldExtract: true,
    });
    expect(state.enabled).toEqual({
      autoCompact: true,
      autoMemory: true,
      autoDream: true,
    });
    expect(state.paths.autoMemoryDir).toBe(path.join(tempDir, 'custom-memory'));
    expect(state.sessionMemory).toMatchObject({
      exists: true,
      isEmpty: true,
    });
    expect(state.sessionTemplate).toContain('# Session Title');
    expect(state.sessionPrompt).toContain('update the session notes file');
  });

  it('parses compact and microcompact boundaries from native transcripts', async () => {
    const tempDir = await createTempDir('actoviq-memory-boundary-');
    process.env.ACTOVIQ_CONFIG_DIR = path.join(tempDir, '.actoviq');

    const projectPath = path.join(tempDir, 'workspace');
    const memory = createActoviqMemoryApi({
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
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'compact-1',
          parentUuid: 'user-1',
          logicalParentUuid: 'user-1',
          timestamp: '2026-04-01T00:01:00.000Z',
          sessionId,
          cwd: projectPath,
          compactMetadata: {
            trigger: 'manual',
            preTokens: 12000,
            messagesSummarized: 14,
            userContext: 'keep current architecture choices',
          },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'microcompact_boundary',
          uuid: 'micro-1',
          parentUuid: 'compact-1',
          logicalParentUuid: 'compact-1',
          timestamp: '2026-04-01T00:02:00.000Z',
          sessionId,
          cwd: projectPath,
          microcompactMetadata: {
            trigger: 'auto',
            preTokens: 18000,
            tokensSaved: 3200,
            compactedToolIds: ['tool-1'],
            clearedAttachmentUUIDs: ['att-1'],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const boundaries = await getActoviqBridgeCompactBoundaries(sessionId, {
      dir: projectPath,
    });
    const latest = await getActoviqBridgeLatestCompactBoundary(sessionId, {
      dir: projectPath,
    });
    const compactState = await memory.compactState({
      sessionId,
      includeBoundaries: true,
      includeSessionMemory: true,
      includeSummaryMessage: true,
    });

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toMatchObject({
      kind: 'compact',
      uuid: 'compact-1',
      metadata: {
        trigger: 'manual',
        preTokens: 12000,
        messagesSummarized: 14,
      },
    });
    expect(boundaries[1]).toMatchObject({
      kind: 'microcompact',
      uuid: 'micro-1',
      metadata: {
        trigger: 'auto',
        preTokens: 18000,
        tokensSaved: 3200,
      },
    });
    expect(latest).toMatchObject({
      kind: 'microcompact',
      uuid: 'micro-1',
    });
    expect(compactState).toMatchObject({
      compactCount: 1,
      microcompactCount: 1,
      hasCompacted: true,
      lastSummarizedMessageUuid: 'user-1',
      canUseSessionMemoryCompaction: false,
    });
    expect(compactState.boundaries).toHaveLength(2);
    expect(compactState.latestBoundary).toMatchObject({
      kind: 'microcompact',
      uuid: 'micro-1',
    });
  });

  it('builds a continuation summary from session memory when compact state requests it', async () => {
    const tempDir = await createTempDir('actoviq-memory-summary-');
    process.env.ACTOVIQ_CONFIG_DIR = path.join(tempDir, '.actoviq');

    const projectPath = path.join(tempDir, 'workspace');
    const sessionId = 'summary-session';
    const memory = createActoviqMemoryApi({
      homeDir: tempDir,
      projectPath,
      sessionId,
    });
    const paths = await memory.paths();

    await mkdir(paths.sessionMemoryDir!, { recursive: true });
    await writeFile(
      paths.sessionMemoryPath!,
      [
        '# Session Title',
        '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
        '',
        'Compact summary fixture',
        '',
        '# Current State',
        '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
        '',
        'Continue wiring deeper compact helpers.',
      ].join('\n'),
      'utf8',
    );

    const summary = await memory.buildSessionMemoryCompactSummary({
      sessionId,
      transcriptPath: path.join(paths.projectStateDir, `${sessionId}.jsonl`),
    });

    expect(summary).toContain('This session is being continued from a previous conversation');
    expect(summary).toContain('Compact summary fixture');
    expect(summary).toContain(`${sessionId}.jsonl`);
    expect(summary).toContain('Recent messages are preserved verbatim.');
  });
});
