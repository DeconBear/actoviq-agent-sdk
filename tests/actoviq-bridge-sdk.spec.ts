import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  createActoviqBridgeSdk,
  loadJsonConfigFile,
} from '../src/index.js';

const tempDirs: string[] = [];
const fixtureCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-actoviq-runtime-cli.mjs');

afterEach(async () => {
  clearLoadedJsonConfig();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Actoviq Runtime SDK bridge', () => {
  it('runs the vendored CLI bridge and inherits loaded JSON env values', async () => {
    const tempDir = await createTempDir('actoviq-runtime-bridge-');
    const configPath = path.join(tempDir, 'bridge-config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        ACTOVIQ_AUTH_TOKEN: 'fixture-token',
      }),
      'utf8',
    );

    await loadJsonConfigFile(configPath);
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('hello-bridge');

      expect(result.text).toBe('echo:hello-bridge;agent:inherit');
      expect(result.sessionId).toBeTruthy();
      expect(result.initEvent?.env_token).toBe('fixture-token');
      expect(result.assistantMessages).toHaveLength(1);
      expect(result.isError).toBe(false);
    } finally {
      await sdk.close();
    }
  });

  it('streams partial events and resolves the final bridge result', async () => {
    const tempDir = await createTempDir('actoviq-runtime-stream-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const stream = sdk.stream('stream-check');
      const deltas: string[] = [];

      for await (const event of stream) {
        if (
          event.type === 'stream_event' &&
          typeof event.event === 'object' &&
          event.event !== null &&
          'delta' in event.event &&
          typeof (event.event as { delta?: { text?: unknown } }).delta?.text === 'string'
        ) {
          deltas.push((event.event as { delta: { text: string } }).delta.text);
        }
      }

      const result = await stream.result;

      expect(deltas.join('')).toBe('echo:stream-check;agent:inherit');
      expect(result.text).toBe('echo:stream-check;agent:inherit');
    } finally {
      await sdk.close();
    }
  });

  it('uses session-id for the first turn and resume for later turns', async () => {
    const tempDir = await createTempDir('actoviq-runtime-session-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const session = await sdk.createSession({ title: 'Fixture Session' });
      const first = await session.send('who-am-i');
      const second = await session.send('who-am-i');

      expect(first.sessionId).toBe(session.id);
      expect(first.text).toBe('mode:session-id;agent:inherit');
      expect(second.text).toBe('mode:resume;agent:inherit');
    } finally {
      await sdk.close();
    }
  });

  it('exposes structured runtime info, skills, commands, and agents', async () => {
    const tempDir = await createTempDir('actoviq-runtime-introspect-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const runtime = await sdk.getRuntimeInfo();
      const skills = await sdk.listSkills();
      const slashCommands = await sdk.listSlashCommands();
      const agents = await sdk.listAgents();

      expect(runtime.model).toBe('fixture-model');
      expect(runtime.tools).toContain('Read');
      expect(runtime.mcpServers[0]?.name).toBe('filesystem');
      expect(skills).toEqual(['debug', 'verify']);
      expect(slashCommands).toEqual(['context', 'cost', 'review', 'compact', 'debug', 'verify']);
      expect(agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'general-purpose',
            sourceGroup: 'Built-in agents',
            active: true,
          }),
          expect.objectContaining({
            name: 'reviewer',
            sourceGroup: 'Project agents',
            memory: 'project',
          }),
          expect.objectContaining({
            name: 'planner',
            active: false,
            shadowedBy: 'User',
          }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('parses structured context usage from the local /context command', async () => {
    const tempDir = await createTempDir('actoviq-runtime-context-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const context = await sdk.getContextUsage();

      expect(context.model).toBe('fixture-model');
      expect(context.tokensUsed).toBe('1.2k');
      expect(context.tokenLimit).toBe('200k');
      expect(context.percentage).toBe(0.6);
      expect(context.categories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'System prompt', tokens: '700' }),
          expect.objectContaining({ name: 'Skills', tokens: '300' }),
        ]),
      );
      expect(context.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'debug', source: 'bundled', tokens: '180' }),
          expect.objectContaining({ name: 'verify', source: 'project', tokens: '120' }),
        ]),
      );
      expect(context.agents[0]).toMatchObject({
        agentType: 'reviewer',
        source: 'project',
        tokens: '240',
      });
      expect(context.mcpTools[0]).toMatchObject({
        tool: 'read_file',
        server: 'filesystem',
        tokens: '80',
      });
    } finally {
      await sdk.close();
    }
  });

  it('invokes slash commands directly through helper methods', async () => {
    const tempDir = await createTempDir('actoviq-runtime-slash-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const direct = await sdk.runSlashCommand('debug', 'trace settings');
      const session = await sdk.createSession();
      const sessionResult = await session.runSlashCommand('verify', 'check tools');

      expect(direct.text).toBe('echo:/debug trace settings;agent:inherit');
      expect(sessionResult.text).toBe('echo:/verify check tools;agent:inherit');
    } finally {
      await sdk.close();
    }
  });

  it('exposes high-level agent helpers for direct runs and agent sessions', async () => {
    const tempDir = await createTempDir('actoviq-runtime-agent-helper-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const direct = await sdk.runWithAgent('reviewer', 'who-am-i');
      const agentHandle = sdk.useAgent('reviewer');
      const session = await agentHandle.createSession({ title: 'Reviewer Session' });
      const sessionResult = await session.send('who-am-i');

      expect(direct.text).toBe('mode:standalone;agent:reviewer');
      expect(sessionResult.text).toBe('mode:session-id;agent:reviewer');
    } finally {
      await sdk.close();
    }
  });

  it('exposes high-level skill helpers and context compaction helpers', async () => {
    const tempDir = await createTempDir('actoviq-runtime-skill-helper-');
    const sdk = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const direct = await sdk.runSkill('debug', 'trace everything');
      const skillHandle = sdk.useSkill('verify');
      const stream = skillHandle.stream('check tools');
      const deltas: string[] = [];

      for await (const event of stream) {
        if (
          event.type === 'stream_event' &&
          typeof event.event === 'object' &&
          event.event !== null &&
          'delta' in event.event &&
          typeof (event.event as { delta?: { text?: unknown } }).delta?.text === 'string'
        ) {
          deltas.push((event.event as { delta: { text: string } }).delta.text);
        }
      }

      const streamed = await stream.result;
      const session = await sdk.createSession();
      const sessionResult = await skillHandle.runInSession(session, 'session pass');
      const compact = await sdk.context.compact('summarize progress');

      expect(direct.text).toBe('echo:/debug trace everything;agent:inherit');
      expect(deltas.join('')).toBe('echo:/verify check tools;agent:inherit');
      expect(streamed.text).toBe('echo:/verify check tools;agent:inherit');
      expect(sessionResult.text).toBe('echo:/verify session pass;agent:inherit');
      expect(compact.text).toBe('compact:/compact summarize progress');
    } finally {
      await sdk.close();
    }
  });
});
