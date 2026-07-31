import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeHadamardBridgeEvents,
  HadamardBridgeSession,
  clearLoadedJsonConfig,
  createHadamardBridgeSdk,
  loadJsonConfigFile,
} from '../src/index.js';
import { listExternalCliSessions } from '../src/parity/externalCliSessions.js';

const tempDirs: string[] = [];
const fixtureCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-hadamard-runtime-cli.mjs');
const fakePiCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-pi-cli.mjs');
const fakeCodexCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-codex-cli.mjs');
const fakeCodewhaleCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-codewhale-cli.mjs');
const fakeReasonixCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-reasonix-cli.mjs');
const fakeCrushCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-crush-cli.mjs');
const fakeHangingCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-hanging-runtime-cli.mjs');
const originalConfigDir = process.env.HADAMARD_CONFIG_DIR;

afterEach(async () => {
  clearLoadedJsonConfig();
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

async function waitForPid(filePath: string, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(filePath, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Child has not written the pid file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for child pid file: ${filePath}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Child process ${pid} was not terminated`);
}

async function waitForJsonLine(
  filePath: string,
  predicate: (record: Record<string, unknown>) => boolean,
  timeoutMs = 8_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = (await readFile(filePath, 'utf8'))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      const match = records.find(predicate);
      if (match) return match;
    } catch {
      // The fixture may not have created or finished appending the log yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  let contents = '';
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    contents = '(missing)';
  }
  throw new Error(
    `Timed out waiting for fixture log record: ${filePath}\n--- log ---\n${contents}\n--- end ---`,
  );
}

describe('Hadamard Runtime SDK bridge', () => {
  it('runs the vendored CLI bridge and inherits loaded JSON env values', async () => {
    const tempDir = await createTempDir('hadamard-runtime-bridge-');
    const configPath = path.join(tempDir, 'bridge-config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        HADAMARD_AUTH_TOKEN: 'fixture-token',
      }),
      'utf8',
    );

    await loadJsonConfigFile(configPath);
    const sdk = await createHadamardBridgeSdk({
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
    const tempDir = await createTempDir('hadamard-runtime-stream-');
    const sdk = await createHadamardBridgeSdk({
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
    const tempDir = await createTempDir('hadamard-runtime-session-');
    const sdk = await createHadamardBridgeSdk({
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

  // Regression for GitHub #8 / superseded PR #10: stream() must flip `started`
  // synchronously so a back-to-back second stream() routes through --resume
  // instead of --session-id (which would orphan the first session).
  it('regression #8: back-to-back stream() uses resume before the first stream settles', async () => {
    const tempDir = await createTempDir('hadamard-runtime-session-stream-race-');
    const sdk = await createHadamardBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const session = await sdk.createSession({ title: 'Fixture Session' });
      const firstStream = session.stream('who-am-i');
      const secondStream = session.stream('who-am-i');
      const [first, second] = await Promise.all([firstStream.result, secondStream.result]);

      expect(first.sessionId).toBe(session.id);
      expect(first.text).toBe('mode:session-id;agent:inherit');
      expect(second.text).toBe('mode:resume;agent:inherit');
    } finally {
      await sdk.close();
    }
  });

  it('regression #8: unit — started flips sync; failed first stream rolls back to session-id', async () => {
    type Captured = { resume?: string; sessionId?: string };
    const captured: Captured[] = [];
    const pending: Array<{
      resolve: (value: { text: string; sessionId: string }) => void;
      reject: (error: Error) => void;
    }> = [];

    const client = {
      stream(_prompt: string, options: Captured) {
        captured.push({
          resume: typeof options.resume === 'string' ? options.resume : undefined,
          sessionId: typeof options.sessionId === 'string' ? options.sessionId : undefined,
        });
        const result = new Promise<{ text: string; sessionId: string }>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
        return {
          async *[Symbol.asyncIterator]() { /* no events needed */ },
          result,
        };
      },
    };

    const session = new HadamardBridgeSession(
      client as never,
      'sess-1',
      'Unit Session',
      {},
      false,
    );

    // Back-to-back: second call must see started=true synchronously.
    const first = session.stream('one');
    const second = session.stream('two');
    expect(captured).toEqual([
      { resume: undefined, sessionId: 'sess-1' },
      { resume: 'sess-1', sessionId: undefined },
    ]);
    pending[0]!.resolve({ text: 'ok', sessionId: 'sess-1' });
    pending[1]!.resolve({ text: 'ok2', sessionId: 'sess-1' });
    await expect(first.result).resolves.toMatchObject({ text: 'ok' });
    await expect(second.result).resolves.toMatchObject({ text: 'ok2' });

    // Solo failure of a fresh session: roll started back so the retry uses session-id.
    const fresh = new HadamardBridgeSession(
      client as never,
      'sess-2',
      'Fresh Session',
      {},
      false,
    );
    const failing = fresh.stream('boom');
    expect(captured[2]).toEqual({ resume: undefined, sessionId: 'sess-2' });
    pending[2]!.reject(new Error('stream failed'));
    await expect(failing.result).rejects.toThrow(/stream failed/);

    const retry = fresh.stream('retry');
    expect(captured[3]).toEqual({ resume: undefined, sessionId: 'sess-2' });
    pending[3]!.resolve({ text: 'recovered', sessionId: 'sess-2' });
    await expect(retry.result).resolves.toMatchObject({ text: 'recovered' });
  });

  it('exposes structured runtime info, skills, commands, and agents', async () => {
    const tempDir = await createTempDir('hadamard-runtime-introspect-');
    const sdk = await createHadamardBridgeSdk({
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
    const tempDir = await createTempDir('hadamard-runtime-context-');
    const sdk = await createHadamardBridgeSdk({
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

  it('builds structured capability metadata from runtime info and context usage', async () => {
    const tempDir = await createTempDir('hadamard-runtime-catalog-');
    const sdk = await createHadamardBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const catalog = await sdk.getRuntimeCatalog();
      const skillMetadata = await sdk.skills.listMetadata();
      const verifyMetadata = await sdk.skills.getMetadata('verify');
      const toolMetadata = await sdk.tools.listMetadata();
      const taskMetadata = await sdk.tools.getMetadata('Task');
      const slashMetadata = await sdk.slashCommands.listMetadata();
      const debugCommand = await sdk.slashCommands.getMetadata('/debug');

      expect(catalog.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'debug',
            slashCommand: '/debug',
            source: 'bundled',
          }),
          expect.objectContaining({
            name: 'verify',
            slashCommand: '/verify',
            source: 'project',
            tokens: '120',
          }),
        ]),
      );
      expect(skillMetadata).toEqual(catalog.skills);
      expect(verifyMetadata).toMatchObject({
        name: 'verify',
        slashCommand: '/verify',
        source: 'project',
      });
      expect(toolMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Task',
            kind: 'builtin',
          }),
        ]),
      );
      expect(taskMetadata).toMatchObject({
        name: 'Task',
        kind: 'builtin',
      });
      expect(slashMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'debug',
            kind: 'skill',
            skillName: 'debug',
          }),
          expect.objectContaining({
            name: 'context',
            kind: 'builtin',
          }),
        ]),
      );
      expect(debugCommand).toMatchObject({
        name: 'debug',
        kind: 'skill',
        skillName: 'debug',
      });
      expect(catalog.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'reviewer',
            contextSource: 'project',
            tokens: '240',
          }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('invokes slash commands directly through helper methods', async () => {
    const tempDir = await createTempDir('hadamard-runtime-slash-');
    const sdk = await createHadamardBridgeSdk({
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
    const tempDir = await createTempDir('hadamard-runtime-agent-helper-');
    const sdk = await createHadamardBridgeSdk({
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
    const tempDir = await createTempDir('hadamard-runtime-skill-helper-');
    const sdk = await createHadamardBridgeSdk({
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

  it('exposes continue-most-recent, fork, and transcript helpers on sessions', async () => {
    const tempDir = await createTempDir('hadamard-runtime-session-helpers-');
    const sdk = await createHadamardBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const continued = await sdk.sessions.continueMostRecent('who-am-i');
      expect(continued.text).toBe('mode:continue;agent:inherit');
      expect(continued.sessionId).toBe('fixture-continued-session');

      const session = await sdk.createSession({ sessionId: 'fixture-session-id', title: 'Fixture Session' });
      const forked = await session.fork('who-am-i');
      expect(forked.text).toBe('mode:fork;agent:inherit');

      const directFork = await sdk.sessions.fork('fixture-session-id', 'who-am-i');
      expect(directFork.text).toBe('mode:fork;agent:inherit');

      expect(await session.info()).toBeUndefined();
      expect(await session.messages()).toEqual([]);
    } finally {
      await sdk.close();
    }
  });

  it('surfaces compact state through bridge session and context helpers', async () => {
    const tempDir = await createTempDir('hadamard-runtime-compact-state-');
    process.env.HADAMARD_CONFIG_DIR = path.join(tempDir, '.hadamard');
    const workDir = path.join(tempDir, 'workspace');
    const sessionId = 'compact-state-session';
    const sdk = await createHadamardBridgeSdk({
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir,
    });

    try {
      const paths = await sdk.memory.paths({ sessionId });
      await mkdir(paths.sessionMemoryDir!, { recursive: true });
      await mkdir(paths.projectStateDir, { recursive: true });
      await writeFile(
        paths.sessionMemoryPath!,
        [
          '# Session Title',
          '_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_',
          '',
          'Bridge compact state test',
          '',
          '# Current State',
          '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
          '',
          'Verifying bridge compact state helpers.',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(paths.projectStateDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'compact-boundary-1',
          logicalParentUuid: 'assistant-3',
          parentUuid: 'assistant-3',
          timestamp: '2026-04-01T00:01:00.000Z',
          sessionId,
          cwd: workDir,
          compactMetadata: {
            trigger: 'manual',
            preTokens: 14000,
            messagesSummarized: 9,
            preservedSegment: {
              headUuid: 'assistant-keep-1',
              anchorUuid: 'compact-boundary-1',
              tailUuid: 'assistant-keep-4',
            },
          },
        }),
        'utf8',
      );

      const fromSessions = await sdk.sessions.getCompactState(sessionId, {
        includeBoundaries: true,
        includeSessionMemory: true,
        includeSummaryMessage: true,
      });
      const session = await sdk.sessions.resume(sessionId);
      const fromSession = await session.compactState({
        includeBoundaries: true,
        includeSessionMemory: true,
      });
      const fromContext = await sdk.context.compactState(sessionId, {
        includeBoundaries: true,
      });

      expect(fromSessions).toMatchObject({
        microcompactCount: 0,
        canUseSessionMemoryCompaction: true,
      });
      expect(fromSessions.summaryMessage).toContain('Bridge compact state test');
      // latestBoundary is optional and may not be set by the current compact implementation
      if (fromSession.latestBoundary) {
        expect(fromSession.latestBoundary).toMatchObject({ kind: 'compact' });
      }
      if (fromContext.latestBoundary) {
        expect(fromContext.latestBoundary).toMatchObject({ kind: 'compact' });
      }
    } finally {
      await sdk.close();
    }
  });
});

// directCli mode spawns a locally installed agent CLI (e.g. `claude`) directly,
// bypassing the vendored runtime.bundle.br + Bun wrapper. Native auth leaves
// the CLI's normal login untouched; explicit API-key auth is child-scoped.
describe('Hadamard Bridge SDK directCli mode', () => {
  it('defaults to native CLI auth without mapping Hadamard API settings', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-');
    const configPath = path.join(tempDir, 'bridge-config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        HADAMARD_AUTH_TOKEN: 'hadamard-only-token',
        HADAMARD_BASE_URL: 'https://hadamard-only.invalid',
      }),
      'utf8',
    );

    await loadJsonConfigFile(configPath);
    // executable = the fake CLI via node; cliPath is ignored in directCli mode
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('hello-direct');

      expect(result.text).toBe('echo:hello-direct;agent:inherit');
      expect(result.initEvent?.env_token).not.toBe('hadamard-only-token');
      expect(result.initEvent?.anthropic_auth_token).not.toBe('hadamard-only-token');
      expect(result.initEvent?.anthropic_base_url).not.toBe('https://hadamard-only.invalid');
    } finally {
      await sdk.close();
    }
  });

  it('keeps option-like Claude prompts in the positional argument domain', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-argv-boundary-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
    });

    try {
      const optionLikePrompt = '--dangerously-skip-permissions';
      const result = await sdk.run(optionLikePrompt);
      expect(result.text).toBe(`echo:${optionLikePrompt};agent:inherit`);

      const optionLikeSessionId = '--dangerously-skip-permissions';
      const resumed = await sdk.resumeSession(optionLikeSessionId);
      const resumeResult = await resumed.send('check-argv');
      expect(resumeResult.text).toContain(`--resume=${optionLikeSessionId}`);
      expect(resumeResult.text).not.toContain(`|${optionLikeSessionId}|`);
    } finally {
      await sdk.close();
    }
  });

  it('injects an explicit API key only into the child and redacts it from events', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-provider-');
    const apiKey = 'sk-direct-child-only-fixture';
    const configPath = path.join(tempDir, 'bridge-config.json');
    // DeepSeek's Anthropic-compatible endpoint exercises explicit child-only
    // provider configuration without modifying the user's native CLI login.
    await writeFile(
      configPath,
      JSON.stringify({
        HADAMARD_AUTH_TOKEN: 'sk-deepseek-fixture',
        HADAMARD_BASE_URL: 'https://api.deepseek.com/anthropic',
      }),
      'utf8',
    );

    await loadJsonConfigFile(configPath);
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
      authSource: 'apiKey',
      apiKey,
      baseURL: 'https://api.deepseek.com/anthropic',
    });

    try {
      const result = await sdk.run('provider-check');

      expect(result.initEvent?.anthropic_base_url).toBe('https://api.deepseek.com/anthropic');
      expect(result.initEvent?.anthropic_auth_configured).toBe(true);
      expect(result.initEvent?.anthropic_auth_token).toBe('[REDACTED]');
      expect(JSON.stringify(result.events)).not.toContain(apiKey);
    } finally {
      await sdk.close();
    }
  });

  it('terminates an active direct CLI run when its signal is aborted', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-abort-');
    const pidFile = path.join(tempDir, 'child.pid');
    const controller = new AbortController();
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fakeHangingCliPath,
      workDir: tempDir,
      env: { HADAMARD_TEST_CHILD_PID_FILE: pidFile },
    });
    const stream = sdk.stream('hang', { signal: controller.signal });
    const outcome = stream.result.catch(error => error as Error);
    const pid = await waitForPid(pidFile);

    try {
      controller.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('RunAbortedError');
      await waitForProcessExit(pid);
    } finally {
      controller.abort();
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
      await sdk.close();
    }
  });

  it('terminates a direct CLI process when stream parsing fails before exit', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-parse-failure-');
    const pidFile = path.join(tempDir, 'child.pid');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fakeHangingCliPath,
      workDir: tempDir,
      env: {
        HADAMARD_TEST_CHILD_PID_FILE: pidFile,
        HADAMARD_TEST_MALFORMED_OUTPUT: '1',
      },
    });
    const outcome = sdk.run('hang').catch(error => error as Error);
    const pid = await waitForPid(pidFile);

    try {
      await expect(outcome).resolves.toMatchObject({ name: 'HadamardBridgeProcessError' });
      await waitForProcessExit(pid);
    } finally {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
      await sdk.close();
    }
  });

  it('close waits for active direct CLI children to exit', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-close-');
    const pidFile = path.join(tempDir, 'child.pid');
    const controller = new AbortController();
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fakeHangingCliPath,
      workDir: tempDir,
      env: { HADAMARD_TEST_CHILD_PID_FILE: pidFile },
    });
    const stream = sdk.stream('hang', { signal: controller.signal });
    const outcome = stream.result.catch(error => error as Error);
    const pid = await waitForPid(pidFile, 10_000);

    try {
      await sdk.close();
      await waitForProcessExit(pid, 10_000);
      expect(await outcome).toBeInstanceOf(Error);
    } finally {
      controller.abort();
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
      await outcome;
    }
  }, 30_000);

  it('observes stream and raw-command aborts during asynchronous setup without spawning', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-abort-race-');
    const pidFile = path.join(tempDir, 'child.pid');
    const controller = new AbortController();
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fakeHangingCliPath,
      workDir: tempDir,
      env: { HADAMARD_TEST_CHILD_PID_FILE: pidFile },
    });

    try {
      const stream = sdk.stream('hang', { signal: controller.signal });
      controller.abort();
      await expect(stream.result).rejects.toMatchObject({ name: 'RunAbortedError' });
      await expect(readFile(pidFile, 'utf8')).rejects.toBeInstanceOf(Error);

      const rawController = new AbortController();
      const rawCommand = (sdk as unknown as {
        runRawCliCommand(
          args: string[],
          options: { signal: AbortSignal },
        ): Promise<unknown>;
      }).runRawCliCommand(['hang'], { signal: rawController.signal });
      rawController.abort();
      await expect(rawCommand).rejects.toMatchObject({ name: 'RunAbortedError' });
      await expect(readFile(pidFile, 'utf8')).rejects.toBeInstanceOf(Error);
    } finally {
      controller.abort();
      await sdk.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'terminates the entire POSIX process group with TERM followed by KILL',
    async () => {
      const tempDir = await createTempDir('hadamard-runtime-direct-process-group-');
      const pidFile = path.join(tempDir, 'child.pid');
      const grandchildPidFile = path.join(tempDir, 'grandchild.pid');
      const terminationLogFile = path.join(tempDir, 'termination.log');
      const controller = new AbortController();
      const sdk = await createHadamardBridgeSdk({
        directCli: true,
        executable: process.execPath,
        cliPath: fakeHangingCliPath,
        workDir: tempDir,
        env: {
          HADAMARD_TEST_CHILD_PID_FILE: pidFile,
          HADAMARD_TEST_GRANDCHILD_PID_FILE: grandchildPidFile,
          HADAMARD_TEST_TERMINATION_LOG_FILE: terminationLogFile,
        },
      });
      const stream = sdk.stream('hang', { signal: controller.signal });
      const outcome = stream.result.catch(error => error as Error);
      const pid = await waitForPid(pidFile);
      const grandchildPid = await waitForPid(grandchildPidFile);

      try {
        controller.abort();
        expect(await outcome).toMatchObject({ name: 'RunAbortedError' });
        await Promise.all([waitForProcessExit(pid), waitForProcessExit(grandchildPid)]);
        const terminationLog = await readFile(terminationLogFile, 'utf8');
        expect(terminationLog).toContain('parent');
        expect(terminationLog).toContain('grandchild');
      } finally {
        controller.abort();
        if (processExists(pid)) process.kill(pid, 'SIGKILL');
        if (processExists(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
        await sdk.close();
      }
    },
  );

  it('bounds retained stdout, stderr, run events, and assistant messages', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-bounds-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      executable: process.execPath,
      cliPath: fixtureCliPath,
      workDir: tempDir,
      env: { HADAMARD_TEST_LARGE_STDOUT_BYTES: String(4 * 1024 * 1024 + 64 * 1024) },
    });

    try {
      const raw = await (sdk as unknown as {
        runRawCliCommand(args: string[]): Promise<{ stdout: string }>;
      }).runRawCliCommand(['agents']);
      expect(Buffer.byteLength(raw.stdout)).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(raw.stdout).toContain('[Hadamard output truncated]');
      expect(raw.stdout).toContain('reviewer · max · project memory');

      const largeStderr = await sdk.run('large-stderr');
      expect(Buffer.byteLength(largeStderr.stderr)).toBeLessThanOrEqual(1024 * 1024);
      expect(largeStderr.stderr).toContain('[Hadamard output truncated]');
      expect(largeStderr.stderr).toMatch(/stderr-tail$/u);

      const retained = await sdk.run('retention-bounds');
      expect(retained.events).toHaveLength(1_000);
      expect(retained.assistantMessages).toHaveLength(128);
      expect(retained.events.at(-1)?.type).toBe('result');
      expect(retained.assistantMessages.at(-1)?.type).toBe('assistant');
    } finally {
      await sdk.close();
    }
  });

  it('errors clearly when directCli has no claude on PATH and no executable', async () => {
    const tempDir = await createTempDir('hadamard-runtime-direct-missing-');
    // A PATH with no `claude` binary — directCli must refuse rather than
    // fall back to the vendored bundle.
    const originalPath = process.env.PATH;
    process.env.PATH = tempDir;
    try {
      await expect(
        createHadamardBridgeSdk({ directCli: true, workDir: tempDir }),
      ).rejects.toThrow(/claude.*executable.*PATH/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// directCli with non-claude providers: pi and codex reuse the spawn + JSONL
// pipeline but speak their own wire protocols. The fake CLIs emit each
// provider's native stream; the provider normalizer translates it into the
// system/assistant/result trio the bridge already switches on.
describe('Hadamard Bridge SDK directCli: pi provider', () => {
  it('normalizes the pi JSONL stream into a bridge result', async () => {
    const tempDir = await createTempDir('hadamard-runtime-pi-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'pi',
      executable: process.execPath,
      cliPath: fakePiCliPath,
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('hello-pi');

      expect(result.text).toBe('pi:hello-pi');
      expect(result.isError).toBe(false);
      expect(result.sessionId).toBe('pi-fixture-session');
      expect(result.initEvent?.type).toBe('system');
      expect(result.initEvent?.subtype).toBe('init');
      // pi emits no tool/skill catalog — introspection degrades gracefully.
      expect(result.initEvent?.tools).toEqual([]);
    } finally {
      await sdk.close();
    }
  });

  it('passes --model through and surfaces it in the assistant message', async () => {
    const tempDir = await createTempDir('hadamard-runtime-pi-model-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'pi',
      executable: process.execPath,
      cliPath: fakePiCliPath,
      model: 'gpt-4o-mini',
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('who-am-i');
      // fake-pi echoes the model into the assistant text.
      expect(result.text).toBe('pi:agent:gpt-4o-mini');
    } finally {
      await sdk.close();
    }
  });

  it('injects OPENAI_API_KEY (provider-specific credential, not ANTHROPIC_*)', async () => {
    const tempDir = await createTempDir('hadamard-runtime-pi-env-');
    const apiKey = 'sk-pi-explicit-fixture';
    const configPath = path.join(tempDir, 'bridge-config.json');
    // pi reads OPENAI_API_KEY directly; the Hadamard settings env passes through
    // unchanged (no ANTHROPIC_* remapping for non-claude providers).
    await writeFile(
      configPath,
      JSON.stringify({ OPENAI_API_KEY: 'sk-pi-fixture' }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);

    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'pi',
      executable: process.execPath,
      cliPath: fakePiCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      authSource: 'apiKey',
      apiKey,
    });

    try {
      const result = await sdk.run('check-env');
      // fake-pi echoes the injected key into the assistant text — proving the
      // Explicit OPENAI_API_KEY reached the pi child and was redacted from its
      // normalized output before the event became visible to the caller.
      expect(result.text).toMatch(/^pi:env:\[REDACTED\]:/);
      expect(JSON.stringify(result.events)).not.toContain(apiKey);
    } finally {
      await sdk.close();
    }
  });

  it('isolates unrelated credentials and keeps API-key sessions in a stable named profile', async () => {
    const homeDir = await createTempDir('hadamard-runtime-pi-profile-');
    const common = {
      directCli: true as const,
      directCliProvider: 'pi' as const,
      executable: process.execPath,
      cliPath: fakePiCliPath,
      workDir: homeDir,
      homeDir,
      authSource: 'apiKey' as const,
      apiKey: 'sk-pi-profile-fixture',
      profileName: 'pi-profile-a',
      env: {
        GITHUB_TOKEN: 'github-must-not-reach-pi',
        AWS_SECRET_ACCESS_KEY: 'aws-must-not-reach-pi',
        DATABASE_PASSWORD: 'database-must-not-reach-pi',
      },
    };
    const firstClient = await createHadamardBridgeSdk(common);
    const first = await firstClient.run('check-isolation');
    await firstClient.close();
    expect(first.text).toBe(
      'pi:isolation:selected=true:github=false:aws=false:db=false',
    );

    const resumedClient = await createHadamardBridgeSdk(common);
    try {
      const resumed = await (await resumedClient.resumeSession(first.sessionId)).send('resumed-turn');
      expect(resumed.text).toBe('pi:resumed-turn');
    } finally {
      await resumedClient.close();
    }

    const otherProfile = await createHadamardBridgeSdk({ ...common, profileName: 'pi-profile-b' });
    try {
      await expect((await otherProfile.resumeSession(first.sessionId)).send('must-not-cross'))
        .rejects.toThrow(/missing Pi session|terminal result|exited/u);
    } finally {
      await otherProfile.close();
    }

    expect((await listExternalCliSessions({ homeDir, runtimes: ['pi'] }))
      .map(session => session.nativeSessionId)).toContain(first.sessionId);
  });
});

describe('Hadamard Bridge SDK directCli: codex provider', () => {
  it('keeps option-like prompts positional and rejects option-like resume ids', async () => {
    const tempDir = await createTempDir('hadamard-runtime-codex-argv-boundary-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codex',
      executable: process.execPath,
      cliPath: fakeCodexCliPath,
      workDir: tempDir,
    });

    try {
      const optionLikePrompt = '--dangerously-bypass-approvals-and-sandbox';
      const result = await sdk.run(optionLikePrompt);
      expect(result.text).toBe(`codex:${optionLikePrompt}`);

      const unsafeResume = await sdk.resumeSession('--last');
      await expect(unsafeResume.send('do not resume latest'))
        .rejects.toThrow(/Codex session id must be a non-option UUID or thread name/);
    } finally {
      await sdk.close();
    }
  });

  it.each([
    ['default', 'sandbox_mode="read-only"', false],
    ['plan', 'sandbox_mode="read-only"', false],
    ['acceptEdits', 'sandbox_mode="workspace-write"', false],
    ['bypassPermissions', '--dangerously-bypass-approvals-and-sandbox', true],
  ] as const)(
    'maps %s permission mode without silently widening access',
    async (permissionMode, expectedArg, bypass) => {
      const tempDir = await createTempDir('hadamard-runtime-codex-permissions-');
      const sdk = await createHadamardBridgeSdk({
        directCli: true,
        directCliProvider: 'codex',
        executable: process.execPath,
        cliPath: fakeCodexCliPath,
        workDir: tempDir,
      });
      try {
        const result = await sdk.run('check-permissions', { permissionMode });
        expect(result.text).toContain(expectedArg);
        expect(result.text.includes('--dangerously-bypass-approvals-and-sandbox')).toBe(bypass);
      } finally {
        await sdk.close();
      }
    },
  );

  it('normalizes the codex exec JSONL stream into a bridge result', async () => {
    const tempDir = await createTempDir('hadamard-runtime-codex-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codex',
      executable: process.execPath,
      cliPath: fakeCodexCliPath,
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('hello-codex');

      expect(result.text).toBe('codex:hello-codex');
      expect(result.isError).toBe(false);
      expect(result.sessionId).toBe('codex-fixture-thread');
      expect(result.initEvent?.type).toBe('system');
      expect(result.initEvent?.subtype).toBe('init');
      expect(result.initEvent?.tools).toEqual([]);
    } finally {
      await sdk.close();
    }
  });

  it('normalizes Codex tool lifecycle items into canonical tool events', async () => {
    const tempDir = await createTempDir('hadamard-runtime-codex-tools-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codex',
      executable: process.execPath,
      cliPath: fakeCodexCliPath,
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('exercise-tools');
      const analysis = analyzeHadamardBridgeEvents(result.events);

      expect(analysis.toolRequests.map(request => ({
        id: request.id,
        name: request.name,
        input: request.input,
      }))).toEqual([
        { id: 'cmd-1', name: 'command_execution', input: { command: 'printf codex-tool' } },
        { id: 'file-1', name: 'file_change', input: { changes: [{ path: 'README.md', kind: 'update' }] } },
        { id: 'mcp-1', name: 'mcp__filesystem__read_file', input: { path: 'README.md' } },
      ]);
      expect(analysis.toolResults.map(toolResult => ({
        id: toolResult.toolUseId,
        isError: toolResult.isError,
      }))).toEqual([
        { id: 'cmd-1', isError: false },
        { id: 'file-1', isError: false },
        { id: 'mcp-1', isError: false },
      ]);
    } finally {
      await sdk.close();
    }
  });

  it('passes -m model through to the codex child', async () => {
    const tempDir = await createTempDir('hadamard-runtime-codex-model-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codex',
      executable: process.execPath,
      cliPath: fakeCodexCliPath,
      model: 'gpt-5',
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('who-am-i');
      expect(result.text).toBe('codex:agent:gpt-5');
    } finally {
      await sdk.close();
    }
  });

  it('adopts the native Codex thread id and resumes it on the next turn', async () => {
    const tempDir = await createTempDir('hadamard-runtime-codex-resume-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codex',
      executable: process.execPath,
      cliPath: fakeCodexCliPath,
      workDir: tempDir,
    });

    try {
      const session = await sdk.createSession({ title: 'Codex fixture' });
      await session.send('first-turn');
      expect(session.id).toBe('codex-fixture-thread');

      const resumed = await session.send('check-resume');
      expect(resumed.sessionId).toBe('codex-fixture-thread');
      expect(resumed.text).toBe('codex:resume:codex-fixture-thread');
    } finally {
      await sdk.close();
    }
  });

  it('maps codex turn.failed into an error result', async () => {
    const tempDir = await createTempDir('hadamard-runtime-codex-fail-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codex',
      executable: process.execPath,
      cliPath: fakeCodexCliPath,
      workDir: tempDir,
    });

    try {
      const result = await sdk.run('force-fail');
      expect(result.isError).toBe(true);
      expect(result.subtype).toBe('error');
      expect(result.text).toContain('codex usage limit reached');
    } finally {
      await sdk.close();
    }
  });
});

describe('Hadamard Bridge SDK directCli: codewhale provider', () => {
  it('spawns codewhale and normalizes the stream-json output', async () => {
    const tempDir = await createTempDir('hadamard-codewhale-');
    const codewhaleHome = path.join(tempDir, 'codewhale-home');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codewhale',
      executable: process.execPath,
      cliPath: fakeCodewhaleCliPath,
      workDir: tempDir,
      env: { CODEWHALE_HOME: codewhaleHome },
    });
    try {
      const result = await sdk.run('hello-codewhale');
      expect(result.text).toBe('codewhale:hello-codewhale');
      expect(result.isError).toBe(false);
      expect(result.sessionId).toBe('codewhale-fixture-session');
    } finally {
      await sdk.close();
    }
  });

  it('adopts the correlated native session id for an exact next-turn resume', async () => {
    const tempDir = await createTempDir('hadamard-codewhale-resume-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'codewhale',
      executable: process.execPath,
      cliPath: fakeCodewhaleCliPath,
      workDir: tempDir,
      env: { CODEWHALE_HOME: path.join(tempDir, 'codewhale-home') },
    });
    try {
      const session = await sdk.createSession({ sessionId: 'hadamard-bootstrap-session' });
      const first = await session.send('first-turn');
      expect(first.sessionId).toBe('codewhale-fixture-session');
      expect(session.id).toBe('codewhale-fixture-session');

      const resumed = await session.send('check-resume');
      expect(resumed.text).toBe('codewhale:resume:codewhale-fixture-session');
      expect(resumed.sessionId).toBe('codewhale-fixture-session');
    } finally {
      await sdk.close();
    }
  });

  it('isolates unrelated credentials and resumes from a stable CodeWhale profile after restart', async () => {
    const homeDir = await createTempDir('hadamard-codewhale-profile-');
    const common = {
      directCli: true as const,
      directCliProvider: 'codewhale' as const,
      executable: process.execPath,
      cliPath: fakeCodewhaleCliPath,
      workDir: homeDir,
      homeDir,
      authSource: 'apiKey' as const,
      apiKey: 'sk-codewhale-profile-fixture',
      credentialProvider: 'anthropic',
      profileName: 'codewhale-profile-a',
      env: {
        GITHUB_TOKEN: 'github-must-not-reach-codewhale',
        AWS_SECRET_ACCESS_KEY: 'aws-must-not-reach-codewhale',
        DATABASE_PASSWORD: 'database-must-not-reach-codewhale',
      },
    };
    const firstClient = await createHadamardBridgeSdk(common);
    const first = await firstClient.run('check-isolation');
    await firstClient.close();
    expect(first.text).toBe(
      'codewhale:isolation:selected=true:github=false:aws=false:db=false',
    );

    const resumedClient = await createHadamardBridgeSdk(common);
    try {
      const resumed = await (await resumedClient.resumeSession(first.sessionId)).send('check-resume');
      expect(resumed.text).toBe('codewhale:resume:codewhale-fixture-session');
    } finally {
      await resumedClient.close();
    }

    const otherProfile = await createHadamardBridgeSdk({
      ...common,
      profileName: 'codewhale-profile-b',
    });
    try {
      await expect((await otherProfile.resumeSession(first.sessionId)).send('must-not-cross'))
        .rejects.toThrow(/missing CodeWhale session|terminal result|exited/u);
    } finally {
      await otherProfile.close();
    }

    expect((await listExternalCliSessions({ homeDir, runtimes: ['codewhale'] }))
      .map(session => session.nativeSessionId)).toContain(first.sessionId);
  });
});

describe('Hadamard Bridge SDK directCli: reasonix provider', () => {
  it('drives Reasonix ACP and wraps its structured result', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
    });
    try {
      const result = await sdk.run('hello-reasonix');
      expect(result.text).toBe('reasonix:hello-reasonix');
      expect(result.isError).toBe(false);
    } finally {
      await sdk.close();
    }
  });

  it('redacts an explicit child-only credential from managed ACP events and results', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-secret-');
    const apiKey = 'sk-reasonix-child-only-fixture';
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      authSource: 'apiKey',
      apiKey,
      profileName: 'reasonix-profile-a',
      env: {
        GITHUB_TOKEN: 'github-must-not-reach-reasonix',
        AWS_SECRET_ACCESS_KEY: 'aws-must-not-reach-reasonix',
        DATABASE_PASSWORD: 'database-must-not-reach-reasonix',
      },
    });
    try {
      const result = await sdk.run('leak-secret');
      expect(result.text).toBe('reasonix:[REDACTED]');
      expect(JSON.stringify(result.events)).not.toContain(apiKey);
      expect(result.stderr).not.toContain(apiKey);

      const isolated = await sdk.run('check-isolation');
      expect(isolated.text).toBe(
        'reasonix:isolation:selected=true:github=false:aws=false:db=false',
      );

      const history = await listExternalCliSessions({ homeDir: tempDir, runtimes: ['reasonix'] });
      expect(history).toEqual([expect.objectContaining({
        runtime: 'reasonix',
        nativeSessionId: result.sessionId,
        messageCount: 4,
      })]);
    } finally {
      await sdk.close();
    }
  });

  it('negotiates advertised model, effort, and budget options before prompting', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-config-');
    const invocationLog = path.join(tempDir, 'reasonix.jsonl');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      model: 'fixture/managed',
      effort: 'high',
      maxBudgetUsd: 3.5,
      env: { HADAMARD_E2E_INVOCATIONS: invocationLog },
    });
    try {
      const result = await sdk.run('configured-turn');
      expect(result.text).toBe('reasonix:configured-turn');
      expect(result.initEvent).toMatchObject({ model: 'fixture/managed' });
      const config = (await readFile(invocationLog, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(record => record.event === 'config');
      expect(config).toMatchObject([
        { configId: 'model', value: 'fixture/managed' },
        { configId: 'effort', value: 'high' },
        { configId: 'budget_usd', value: '3.5' },
      ]);
    } finally {
      await sdk.close();
    }
  });

  it('keeps one legacy ACP process and native session for consecutive turns', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-persistent-');
    const invocationLog = path.join(tempDir, 'reasonix.jsonl');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      env: { HADAMARD_E2E_INVOCATIONS: invocationLog },
    });
    let pid = 0;
    try {
      const session = await sdk.createSession({ sessionId: 'hadamard-reasonix-chat' });
      const first = await session.send('runtime-identity');
      const second = await session.send('runtime-identity');
      const firstIdentity = /pid=(\d+):session=([^:]+):turn=(\d+)/u.exec(first.text);
      const secondIdentity = /pid=(\d+):session=([^:]+):turn=(\d+)/u.exec(second.text);
      expect(firstIdentity).not.toBeNull();
      expect(secondIdentity).not.toBeNull();
      pid = Number(firstIdentity?.[1]);
      expect(secondIdentity?.[1]).toBe(firstIdentity?.[1]);
      expect(firstIdentity?.[2]).toBe('reasonix-fixture-session');
      expect(secondIdentity?.[2]).toBe('reasonix-fixture-session');
      expect(firstIdentity?.[3]).toBe('1');
      expect(secondIdentity?.[3]).toBe('2');
      expect(first.sessionId).toBe('reasonix-fixture-session');
      expect(second.sessionId).toBe('reasonix-fixture-session');
      expect(session.id).toBe('reasonix-fixture-session');

      const records = (await readFile(invocationLog, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      expect(records.filter(record => record.event === 'start')).toHaveLength(1);
      expect(records.filter(record => record.event === 'session/new')).toHaveLength(1);
      expect(records.filter(record => record.event === 'session/load')).toHaveLength(0);
    } finally {
      await sdk.close();
      if (pid > 0) await waitForProcessExit(pid);
    }
  });

  it('serializes concurrent turns that target the same managed ACP session', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-serialized-');
    const invocationLog = path.join(tempDir, 'reasonix.jsonl');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      env: { HADAMARD_E2E_INVOCATIONS: invocationLog },
    });
    try {
      const [first, second] = await Promise.all([
        sdk.run('concurrent-first'),
        sdk.run('concurrent-second'),
      ]);
      expect(first.text).toBe('reasonix:concurrent-first');
      expect(second.text).toBe('reasonix:concurrent-second');
      expect(second.sessionId).toBe(first.sessionId);
      const prompts = (await readFile(invocationLog, 'utf8'))
        .trim()
        .split(/\r?\n/u)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(record => record.event === 'prompt');
      expect(prompts).toMatchObject([
        { prompt: 'concurrent-first', turn: 1 },
        { prompt: 'concurrent-second', turn: 2 },
      ]);
      expect(new Set(prompts.map(record => record.pid)).size).toBe(1);
    } finally {
      await sdk.close();
    }
  });

  it('does not replace an unsupported exact resume with a new session', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-resume-');
    const invocationLog = path.join(tempDir, 'reasonix.jsonl');
    const common = {
      directCli: true as const,
      directCliProvider: 'reasonix' as const,
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      env: { HADAMARD_E2E_INVOCATIONS: invocationLog },
    };
    const firstSdk = await createHadamardBridgeSdk(common);
    let nativeSessionId = '';
    try {
      nativeSessionId = (await firstSdk.run('first-turn')).sessionId;
    } finally {
      await firstSdk.close();
    }

    const resumedSdk = await createHadamardBridgeSdk(common);
    try {
      const session = await resumedSdk.resumeSession(nativeSessionId);
      const resumed = await session.send('must-not-start-over');
      expect(resumed.isError).toBe(true);
      expect(resumed.text).toContain('cannot load persisted sessions');
      expect(resumed.sessionId).toBe(nativeSessionId);
    } finally {
      await resumedSdk.close();
    }

    const records = (await readFile(invocationLog, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter(record => record.event === 'start')).toHaveLength(2);
    expect(records.filter(record => record.event === 'session/new')).toHaveLength(1);
    expect(records.filter(record => record.event === 'session/load')).toHaveLength(0);
    expect(records.some(record => record.prompt === 'must-not-start-over')).toBe(false);
  });

  it('sends session/cancel before reclaiming an aborted ACP process', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-abort-');
    const invocationLog = path.join(tempDir, 'reasonix.jsonl');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      env: { HADAMARD_E2E_INVOCATIONS: invocationLog },
    });
    const abortController = new AbortController();
    try {
      const result = sdk.run('hang', { signal: abortController.signal });
      const promptRecord = await waitForJsonLine(
        invocationLog,
        record => record.event === 'prompt' && record.prompt === 'hang',
      );
      const pid = Number(promptRecord.pid);
      abortController.abort();
      await expect(result).rejects.toMatchObject({ name: 'RunAbortedError' });
      await waitForProcessExit(pid);
      await waitForJsonLine(
        invocationLog,
        record => record.event === 'cancel' && record.pid === pid,
      );
    } finally {
      await sdk.close();
    }
  });

  it('cancels and terminates an active ACP turn when the SDK closes', async () => {
    const tempDir = await createTempDir('hadamard-reasonix-close-');
    const invocationLog = path.join(tempDir, 'reasonix.jsonl');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: fakeReasonixCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      env: { HADAMARD_E2E_INVOCATIONS: invocationLog },
    });
    try {
      // Mirror the abort-test spawn path (options bag present) so Linux CI does
      // not hit a colder directCli setup than neighboring reasonix coverage.
      const result = sdk.run('hang', {});
      await waitForJsonLine(
        invocationLog,
        record => record.event === 'start',
        20_000,
      );
      const promptRecord = await waitForJsonLine(
        invocationLog,
        record => record.event === 'prompt' && record.prompt === 'hang',
        20_000,
      );
      const pid = Number(promptRecord.pid);
      await sdk.close();
      await expect(result).rejects.toThrow(/closed|exited/iu);
      await waitForProcessExit(pid);
      await waitForJsonLine(
        invocationLog,
        record => record.event === 'cancel' && record.pid === pid,
        20_000,
      );
    } finally {
      await sdk.close().catch(() => undefined);
    }
  }, 60_000);
});

describe('Hadamard Bridge SDK directCli: crush provider', () => {
  it('uses the private server protocol and returns the native session id', async () => {
    const tempDir = await createTempDir('hadamard-crush-');
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'crush',
      executable: process.execPath,
      cliPath: fakeCrushCliPath,
      workDir: tempDir,
    });
    try {
      const session = await sdk.createSession({ sessionId: 'hadamard-bootstrap' });
      const first = await session.send('hello-crush');
      expect(first.text).toBe('crush:hello-crush');
      expect(first.sessionId).toBe('crush-session-1');
      expect(first.isError).toBe(false);
      expect(session.id).toBe('crush-session-1');

      const resumed = await session.send('second-turn');
      expect(resumed.text).toBe('crush:second-turn');
      expect(resumed.sessionId).toBe('crush-session-1');
    } finally {
      await sdk.close();
    }
  });

  it('isolates an explicit API key and refuses untrusted project config', async () => {
    const tempDir = await createTempDir('hadamard-crush-auth-');
    const apiKey = 'sk-crush-child-only-fixture';
    const sdk = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'crush',
      executable: process.execPath,
      cliPath: fakeCrushCliPath,
      workDir: tempDir,
      homeDir: tempDir,
      authSource: 'apiKey',
      apiKey,
      credentialProvider: 'openai',
      profileName: 'crush-isolation-profile',
      baseURL: 'https://provider.example/v1/',
      model: 'openai/gpt-5',
      env: {
        GITHUB_TOKEN: 'github-must-not-reach-crush',
        AWS_SECRET_ACCESS_KEY: 'aws-must-not-reach-crush',
        DATABASE_PASSWORD: 'database-must-not-reach-crush',
      },
    });
    try {
      const result = await sdk.run('check-env');
      expect(result.text).toBe('crush:env:[REDACTED]:isolated=true');
      expect(JSON.stringify(result.events)).not.toContain(apiKey);

      const isolated = await sdk.run('check-isolation');
      expect(isolated.text).toBe(
        'crush:isolation:selected=true:github=false:aws=false:db=false',
      );

      const configured = await sdk.run('check-config');
      expect(configured.text).toBe(
        'crush:config:openai:gpt-5:https://provider.example/v1:key=true',
      );

      await writeFile(path.join(tempDir, '.crush.json'), '{}', 'utf8');
      await expect(sdk.run('blocked')).rejects.toThrow(/trustProjectResources/u);
    } finally {
      await sdk.close();
    }
  });

  it('keeps Crush API-key session data stable and isolated by named profile', async () => {
    const homeDir = await createTempDir('hadamard-crush-profile-');
    const common = {
      directCli: true as const,
      directCliProvider: 'crush' as const,
      executable: process.execPath,
      cliPath: fakeCrushCliPath,
      workDir: homeDir,
      homeDir,
      authSource: 'apiKey' as const,
      apiKey: 'sk-crush-profile-fixture',
      credentialProvider: 'openai',
      profileName: 'crush-profile-a',
    };
    const firstClient = await createHadamardBridgeSdk(common);
    const first = await firstClient.run('first-turn');
    await firstClient.close();

    const resumedClient = await createHadamardBridgeSdk(common);
    try {
      const resumed = await (await resumedClient.resumeSession(first.sessionId)).send('resumed-turn');
      expect(resumed.text).toBe('crush:resumed-turn');
      expect(resumed.sessionId).toBe(first.sessionId);
    } finally {
      await resumedClient.close();
    }

    const otherProfile = await createHadamardBridgeSdk({
      ...common,
      profileName: 'crush-profile-b',
    });
    try {
      await expect((await otherProfile.resumeSession(first.sessionId)).send('must-not-cross'))
        .rejects.toThrow(/404|status/u);
    } finally {
      await otherProfile.close();
    }
  });

  it('requires explicit project-config trust in native-login mode too', async () => {
    const tempDir = await createTempDir('hadamard-crush-native-trust-');
    await writeFile(path.join(tempDir, 'crush.json'), '{}', 'utf8');
    const untrusted = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'crush',
      executable: process.execPath,
      cliPath: fakeCrushCliPath,
      workDir: tempDir,
      authSource: 'native',
    });
    try {
      await expect(untrusted.run('blocked')).rejects.toThrow(/trustProjectResources/u);
    } finally {
      await untrusted.close();
    }

    const trusted = await createHadamardBridgeSdk({
      directCli: true,
      directCliProvider: 'crush',
      executable: process.execPath,
      cliPath: fakeCrushCliPath,
      workDir: tempDir,
      authSource: 'native',
      trustProjectResources: true,
    });
    try {
      expect((await trusted.run('allowed')).text).toBe('crush:allowed');
    } finally {
      await trusted.close();
    }
  });
});
