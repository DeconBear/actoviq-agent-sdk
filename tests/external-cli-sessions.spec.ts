import {
  appendFile,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsSpies = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (
      filePath: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1],
    ) => {
      fsSpies.createReadStream(filePath, options);
      return actual.createReadStream(filePath, options);
    },
  };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      fsSpies.readFile(...args);
      throw new Error('external session history must not use whole-file reads');
    },
  };
});

import {
  codewhaleRedactedIdentifierForLog,
  listExternalCliSessions,
  readExternalCliSession,
  resolveCodewhaleNativeSessionId,
} from '../src/parity/externalCliSessions.js';
import {
  createCrushSessionReference,
  parseCrushSessionReferenceDetails,
  type CrushHistoryCommandRunner,
} from '../src/parity/crushSessionHistory.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })));
  fsSpies.createReadStream.mockClear();
  fsSpies.readFile.mockClear();
  vi.unstubAllEnvs();
});

describe('Crush command-backed external history aggregation', () => {
  const crushSessionId = '33333333-3333-4333-8333-333333333333';

  it('merges Crush metadata into global pagination before opening file transcripts', async () => {
    const tempDir = await createTempDir('actoviq-external-crush-order-');
    const claudeRoot = path.join(tempDir, 'claude');
    const claudeSessionId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const claudePath = path.join(claudeRoot, `${claudeSessionId}.jsonl`);
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(claudePath, `${JSON.stringify({
      type: 'user',
      sessionId: claudeSessionId,
      message: { role: 'user', content: 'file-backed session' },
    })}\n`, 'utf8');
    const fileTime = new Date('2026-07-13T10:00:00.000Z');
    await utimes(claudePath, fileTime, fileTime);
    const commandRunner = vi.fn<CrushHistoryCommandRunner>(async () => ({
      stdout: JSON.stringify([{
        uuid: crushSessionId,
        title: 'Crush session',
        created: '2026-07-13T09:00:00.000Z',
        modified: '2026-07-13T10:00:02.000Z',
      }]),
      stderr: '',
      exitCode: 0,
    }));

    const summaries = await listExternalCliSessions({
      claudeRoot,
      runtimes: ['claude', 'crush'],
      crushCwd: tempDir,
      crushCommandRunner: commandRunner,
      offset: 1,
      limit: 1,
    });

    expect(summaries.map(summary => summary.nativeSessionId)).toEqual([claudeSessionId]);
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(fsSpies.createReadStream).toHaveBeenCalledTimes(1);
  });

  it('routes an opaque Crush reference to the exact command-backed detail reader', async () => {
    const reference = createCrushSessionReference(crushSessionId);
    const commandRunner = vi.fn<CrushHistoryCommandRunner>(async request => ({
      stdout: JSON.stringify({
        meta: {
          uuid: crushSessionId,
          title: 'Crush detail',
          created: '2026-07-13T09:00:00.000Z',
          modified: '2026-07-13T10:00:02.000Z',
        },
        messages: [{
          role: 'assistant',
          created: '2026-07-13T10:00:01.000Z',
          parts: [{ type: 'text', text: 'managed history' }],
        }],
      }),
      stderr: '',
      exitCode: 0,
    }));

    const session = await readExternalCliSession(reference, {
      runtimes: ['crush'],
      crushCwd: process.cwd(),
      crushCommandRunner: commandRunner,
    });

    expect(commandRunner.mock.calls[0]?.[0].args).toEqual([
      'session',
      'show',
      crushSessionId,
      '--json',
    ]);
    expect(session?.summary).toMatchObject({ runtime: 'crush', nativeSessionId: crushSessionId });
    expect(session?.messages.map(message => message.text)).toEqual(['managed history']);
    expect(fsSpies.createReadStream).not.toHaveBeenCalled();
  });

  it('keeps the native CLI home separate from managed Crush data-root profiles', async () => {
    const homeDir = await createTempDir('actoviq-external-crush-profiles-');
    const actoviqHomeDir = path.join(homeDir, 'custom-actoviq-data-root');
    const profileA = 'a'.repeat(64);
    const profileB = 'b'.repeat(64);
    const dataA = path.join(
      actoviqHomeDir,
      'external-cli-profiles',
      'crush',
      profileA,
      'data',
    );
    const dataB = path.join(
      actoviqHomeDir,
      'external-cli-profiles',
      'crush',
      profileB,
      'data',
    );
    await Promise.all([
      mkdir(dataA, { recursive: true }),
      mkdir(dataB, { recursive: true }),
    ]);
    const explicitNativeData = path.join(homeDir, 'native-data');
    const commandRunner = vi.fn<CrushHistoryCommandRunner>(async request => {
      const dataDir = request.env.CRUSH_GLOBAL_DATA;
      const source = dataDir === dataA
        ? { title: 'Managed A', text: 'managed A detail', modified: '2026-07-13T10:00:03Z' }
        : dataDir === dataB
          ? { title: 'Managed B', text: 'managed B detail', modified: '2026-07-13T10:00:02Z' }
          : { title: 'Native', text: 'native detail', modified: '2026-07-13T10:00:01Z' };
      return request.args[1] === 'list'
        ? {
            stdout: JSON.stringify([{
              uuid: crushSessionId,
              title: source.title,
              created: '2026-07-13T09:00:00Z',
              modified: source.modified,
            }]),
            stderr: '',
            exitCode: 0,
          }
        : {
            stdout: JSON.stringify({
              meta: {
                uuid: crushSessionId,
                title: source.title,
                created: '2026-07-13T09:00:00Z',
                modified: source.modified,
              },
              messages: [{
                role: 'assistant',
                created: source.modified,
                parts: [{ type: 'text', text: source.text }],
              }],
            }),
            stderr: '',
            exitCode: 0,
          };
    });
    const options = {
      homeDir,
      actoviqHomeDir,
      runtimes: ['crush' as const],
      crushEnv: { CRUSH_GLOBAL_DATA: explicitNativeData },
      crushCommandRunner: commandRunner,
    };

    const summaries = await listExternalCliSessions(options);

    expect(summaries).toHaveLength(3);
    expect(summaries.map(summary => summary.nativeSessionId))
      .toEqual([crushSessionId, crushSessionId, crushSessionId]);
    expect(new Set(summaries.map(summary => summary.path)).size).toBe(3);
    expect(summaries.map(summary => parseCrushSessionReferenceDetails(summary.path)))
      .toEqual([
        { nativeSessionId: crushSessionId, managedProfileId: profileA },
        { nativeSessionId: crushSessionId, managedProfileId: profileB },
        { nativeSessionId: crushSessionId },
      ]);
    expect(commandRunner.mock.calls.map(call => call[0].env.CRUSH_GLOBAL_DATA))
      .toEqual(expect.arrayContaining([explicitNativeData, dataA, dataB]));

    const managedAReference = summaries[0]?.path ?? '';
    commandRunner.mockClear();
    const managedA = await readExternalCliSession(managedAReference, options);
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner.mock.calls[0]?.[0].env.CRUSH_GLOBAL_DATA).toBe(dataA);
    expect(managedA?.messages.map(message => message.text)).toEqual(['managed A detail']);

    commandRunner.mockClear();
    await expect(readExternalCliSession(
      createCrushSessionReference(crushSessionId, 'f'.repeat(64)),
      options,
    )).resolves.toBeUndefined();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('ignores malformed, non-hash, and symlinked managed Crush profiles', async () => {
    const homeDir = await createTempDir('actoviq-external-crush-profile-safety-');
    const profilesRoot = path.join(
      homeDir,
      '.actoviq',
      'external-cli-profiles',
      'crush',
    );
    const symlinkedDataProfile = 'c'.repeat(64);
    const symlinkedProfile = 'd'.repeat(64);
    const outsideData = path.join(homeDir, 'outside-data');
    const outsideProfile = path.join(homeDir, 'outside-profile');
    await Promise.all([
      mkdir(path.join(profilesRoot, 'not-a-profile-id', 'data'), { recursive: true }),
      mkdir(path.join(profilesRoot, symlinkedDataProfile), { recursive: true }),
      mkdir(outsideData, { recursive: true }),
      mkdir(path.join(outsideProfile, 'data'), { recursive: true }),
    ]);
    try {
      await symlink(
        outsideData,
        path.join(profilesRoot, symlinkedDataProfile, 'data'),
        'junction',
      );
      await symlink(outsideProfile, path.join(profilesRoot, symlinkedProfile), 'junction');
    } catch (error) {
      if (!isRecordWithCode(error) || (error.code !== 'EPERM' && error.code !== 'EACCES')) {
        throw error;
      }
    }
    const commandRunner = vi.fn<CrushHistoryCommandRunner>(async () => ({
      stdout: '[]',
      stderr: '',
      exitCode: 0,
    }));
    const options = {
      homeDir,
      runtimes: ['crush' as const],
      crushCommandRunner: commandRunner,
    };

    await listExternalCliSessions(options);
    expect(commandRunner).toHaveBeenCalledTimes(1);

    commandRunner.mockClear();
    await expect(readExternalCliSession(
      createCrushSessionReference(crushSessionId, symlinkedDataProfile),
      options,
    )).resolves.toBeUndefined();
    await expect(readExternalCliSession(
      `actoviq-crush-session:v2:${Buffer.from('../../outside').toString('base64url')}`,
      options,
    )).resolves.toBeUndefined();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('bounds managed Crush profile discovery to 256 safe directories', async () => {
    const homeDir = await createTempDir('actoviq-external-crush-profile-limit-');
    const profilesRoot = path.join(
      homeDir,
      '.actoviq',
      'external-cli-profiles',
      'crush',
    );
    const profileIds = Array.from(
      { length: 257 },
      (_, index) => index.toString(16).padStart(64, '0'),
    );
    await Promise.all(profileIds.map(profileId =>
      mkdir(path.join(profilesRoot, profileId, 'data'), { recursive: true }),
    ));
    const commandRunner = vi.fn<CrushHistoryCommandRunner>(async () => ({
      stdout: '[]',
      stderr: '',
      exitCode: 0,
    }));

    await listExternalCliSessions({
      homeDir,
      runtimes: ['crush'],
      crushCommandRunner: commandRunner,
    });

    expect(commandRunner).toHaveBeenCalledTimes(257);
    const managedDataDirs = commandRunner.mock.calls
      .map(call => call[0].env.CRUSH_GLOBAL_DATA)
      .filter((value): value is string => Boolean(value?.startsWith(profilesRoot)));
    expect(new Set(managedDataDirs).size).toBe(256);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function codewhaleSavedSession(input: {
  id: string;
  title: string;
  workspace: string;
  messages?: Array<Record<string, unknown>>;
  messageCount?: number;
  model?: string;
}): Record<string, unknown> {
  const messages = input.messages ?? [];
  return {
    schema_version: 1,
    metadata: {
      id: input.id,
      title: input.title,
      created_at: '2026-07-14T10:00:00.000Z',
      updated_at: '2026-07-14T10:01:00.000Z',
      message_count: input.messageCount ?? messages.length,
      total_tokens: 42,
      model: input.model ?? 'deepseek-chat',
      workspace: input.workspace,
      cost: {},
      cumulative_turn_secs: 1,
    },
    messages,
  };
}

function isRecordWithCode(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null &&
    'code' in value && typeof value.code === 'string';
}

describe('external CLI session history', () => {
  it('recursively indexes and reads Claude Code sessions from an injected home', async () => {
    const homeDir = await createTempDir('actoviq-external-claude-');
    const cwd = path.join(homeDir, 'workspace');
    const nativeSessionId = '11111111-2222-3333-4444-555555555555';
    const sessionPath = path.join(
      homeDir,
      '.claude',
      'projects',
      'nested',
      'project',
      `${nativeSessionId}.jsonl`,
    );
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'user',
        sessionId: nativeSessionId,
        cwd,
        timestamp: '2026-07-13T08:00:00.000Z',
        message: { role: 'user', content: 'Inspect the runtime bridge' },
      }),
      '{broken-json',
      JSON.stringify({
        type: 'assistant',
        sessionId: nativeSessionId,
        cwd,
        timestamp: '2026-07-13T08:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/index.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: nativeSessionId,
        cwd,
        timestamp: '2026-07-13T08:00:02.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'export {}',
          }],
        },
      }),
      '{"type":"assistant"',
    ].join('\n'), 'utf8');

    const summaries = await listExternalCliSessions({ homeDir });
    expect(summaries).toEqual([
      expect.objectContaining({
        runtime: 'claude',
        nativeSessionId,
        title: 'Inspect the runtime bridge',
        cwd,
        createdAt: '2026-07-13T08:00:00.000Z',
        updatedAt: '2026-07-13T08:00:02.000Z',
        messageCount: 3,
        path: expect.any(String),
      }),
    ]);

    const session = await readExternalCliSession(sessionPath, { homeDir });
    expect(session?.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(session?.messages[1]).toMatchObject({
      text: 'I will inspect it.',
      model: 'claude-sonnet-4-5',
      tools: [{
        kind: 'call',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'src/index.ts' },
      }],
    });
    expect(session?.messages[2]?.tools).toEqual([{
      kind: 'result',
      id: 'tool-1',
      output: 'export {}',
      isError: undefined,
    }]);
  });

  it('indexes Codex rollout JSONL from an explicit root without duplicating event messages', async () => {
    const tempDir = await createTempDir('actoviq-external-codex-');
    const codexRoot = path.join(tempDir, 'custom-codex-sessions');
    const claudeRoot = path.join(tempDir, 'no-claude-sessions');
    const piRoot = path.join(tempDir, 'no-pi-sessions');
    const codewhaleRoot = path.join(tempDir, 'no-codewhale-sessions');
    const cwd = path.join(tempDir, 'workspace');
    const nativeSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionPath = path.join(codexRoot, '2026', '07', '13', `rollout-${nativeSessionId}.jsonl`);
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        timestamp: '2026-07-13T09:00:00.000Z',
        type: 'session_meta',
        payload: { id: nativeSessionId, cwd },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:01.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5-codex', cwd },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Fix the parser' },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix the parser' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Checking now.' },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking now.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'shell',
          arguments: '{"cmd":"npm test"}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-13T09:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'passed',
        },
      }),
    ].join('\n'), 'utf8');

    const summaries = await listExternalCliSessions({
      claudeRoot,
      codexRoot,
      piRoot,
      codewhaleRoot,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runtime: 'codex',
      nativeSessionId,
      title: 'Fix the parser',
      cwd,
      createdAt: '2026-07-13T09:00:00.000Z',
      updatedAt: '2026-07-13T09:00:05.000Z',
      messageCount: 4,
    });

    const session = await readExternalCliSession(sessionPath, {
      claudeRoot,
      codexRoot,
      piRoot,
      codewhaleRoot,
    });
    expect(session?.messages.map(message => message.text)).toEqual([
      'Fix the parser',
      'Checking now.',
      '',
      'passed',
    ]);
    expect(session?.messages[0]?.model).toBe('gpt-5-codex');
    expect(session?.messages[2]?.tools).toEqual([{
      kind: 'call',
      id: 'call-1',
      name: 'shell',
      input: '{"cmd":"npm test"}',
    }]);
  });

  it('reads the active branch from Pi v3 history under the default root', async () => {
    const homeDir = await createTempDir('actoviq-external-pi-');
    const cwd = path.join(homeDir, 'workspace');
    const nativeSessionId = '0190f1a2-b3c4-7000-8000-000000000001';
    const sessionPath = path.join(
      homeDir,
      '.pi',
      'agent',
      'sessions',
      '--workspace--',
      `2026-07-14T08-00-00-000Z_${nativeSessionId}.jsonl`,
    );
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: nativeSessionId,
        timestamp: '2026-07-14T08:00:00.000Z',
        cwd,
      }),
      JSON.stringify({
        type: 'message',
        id: 'root0001',
        parentId: null,
        timestamp: '2026-07-14T08:00:01.000Z',
        message: { role: 'user', content: 'Inspect the Pi runtime' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'old00001',
        parentId: 'root0001',
        timestamp: '2026-07-14T08:00:02.000Z',
        message: {
          role: 'assistant',
          model: 'old-model',
          content: [{ type: 'text', text: 'Abandoned answer' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'user0002',
        parentId: 'root0001',
        timestamp: '2026-07-14T08:00:03.000Z',
        message: { role: 'user', content: 'Use the active branch' },
      }),
      JSON.stringify({
        type: 'model_change',
        id: 'model001',
        parentId: 'user0002',
        timestamp: '2026-07-14T08:00:04.000Z',
        provider: 'openai',
        modelId: 'gpt-5.1-codex',
      }),
      JSON.stringify({
        type: 'message',
        id: 'call0001',
        parentId: 'model001',
        timestamp: '2026-07-14T08:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading it now.' },
            {
              type: 'toolCall',
              id: 'tool-call-1',
              name: 'read',
              arguments: { path: 'src/index.ts' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'result01',
        parentId: 'call0001',
        timestamp: '2026-07-14T08:00:06.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tool-call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'export {}' }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'answer01',
        parentId: 'result01',
        timestamp: '2026-07-14T08:00:07.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5.1-codex',
          content: [{ type: 'text', text: 'The active branch is complete.' }],
        },
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'name0001',
        parentId: 'answer01',
        timestamp: '2026-07-14T08:00:08.000Z',
        name: 'Pi active branch',
      }),
    ].join('\n'), 'utf8');

    const summaries = await listExternalCliSessions({
      homeDir,
      runtimes: ['pi'],
    });
    expect(summaries).toEqual([expect.objectContaining({
      runtime: 'pi',
      nativeSessionId,
      title: 'Pi active branch',
      cwd,
      createdAt: '2026-07-14T08:00:00.000Z',
      updatedAt: '2026-07-14T08:00:08.000Z',
      messageCount: 5,
      path: expect.any(String),
    })]);

    const session = await readExternalCliSession(sessionPath, {
      homeDir,
      runtimes: ['pi'],
    });
    expect(session?.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'Inspect the Pi runtime'],
      ['user', 'Use the active branch'],
      ['assistant', 'Reading it now.'],
      ['tool', 'export {}'],
      ['assistant', 'The active branch is complete.'],
    ]);
    expect(session?.messages.some(message => message.text === 'Abandoned answer')).toBe(false);
    expect(session?.messages[2]).toMatchObject({
      model: 'gpt-5.1-codex',
      tools: [{
        kind: 'call',
        id: 'tool-call-1',
        name: 'read',
        input: { path: 'src/index.ts' },
      }],
    });
    expect(session?.messages[3]).toMatchObject({
      model: 'gpt-5.1-codex',
      tools: [{
        kind: 'result',
        id: 'tool-call-1',
        name: 'read',
        output: 'export {}',
        isError: false,
      }],
    });

    const bounded = await readExternalCliSession(sessionPath, {
      homeDir,
      runtimes: ['pi'],
      detailMaxBytes: 1024 * 1024,
      detailMaxMessages: 3,
    });
    expect(bounded?.truncated).toBe(true);
    expect(bounded?.messages.length).toBeLessThanOrEqual(3);
  });

  it('honors Pi config and session directory environment overrides', async () => {
    const tempDir = await createTempDir('actoviq-external-pi-roots-');
    const agentDir = path.join(tempDir, 'pi-agent-home');
    const configuredSessions = path.join(agentDir, 'sessions');
    const overriddenSessions = path.join(tempDir, 'pi-session-override');

    const writePiSession = async (root: string, id: string, title: string): Promise<void> => {
      const sessionPath = path.join(root, 'project', `2026-07-14_${id}.jsonl`);
      await mkdir(path.dirname(sessionPath), { recursive: true });
      await writeFile(sessionPath, [
        JSON.stringify({
          type: 'session',
          version: 3,
          id,
          timestamp: '2026-07-14T09:00:00.000Z',
          cwd: tempDir,
        }),
        JSON.stringify({
          type: 'message',
          id: 'message1',
          parentId: null,
          timestamp: '2026-07-14T09:00:01.000Z',
          message: { role: 'user', content: title },
        }),
      ].join('\n'), 'utf8');
    };

    await writePiSession(
      configuredSessions,
      '0190f1a2-b3c4-7000-8000-000000000002',
      'Config directory session',
    );
    await writePiSession(
      overriddenSessions,
      '0190f1a2-b3c4-7000-8000-000000000003',
      'Session directory override',
    );

    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    expect((await listExternalCliSessions({ homeDir: tempDir, runtimes: ['pi'] }))
      .map(summary => summary.title)).toEqual(['Config directory session']);

    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', overriddenSessions);
    expect((await listExternalCliSessions({ homeDir: tempDir, runtimes: ['pi'] }))
      .map(summary => summary.title)).toEqual(['Session directory override']);
  });

  it('indexes top-level Reasonix checkpoints from current and legacy roots with sidecar metadata', async () => {
    const homeDir = await createTempDir('actoviq-external-reasonix-roots-');
    const stateHome = path.join(homeDir, 'reasonix-state');
    const currentRoot = path.join(stateHome, 'sessions');
    const legacyRoot = path.join(homeDir, '.reasonix', 'sessions');
    const cwd = path.join(homeDir, 'workspace');
    const currentPath = path.join(currentRoot, 'reasonix-current.jsonl');
    const legacyPath = path.join(legacyRoot, 'reasonix-legacy.jsonl');
    const nestedPath = path.join(currentRoot, 'nested', 'ignored.jsonl');
    await mkdir(path.dirname(nestedPath), { recursive: true });
    await mkdir(legacyRoot, { recursive: true });

    await writeFile(currentPath, [
      JSON.stringify({ role: 'system', content: 'System instructions' }),
      JSON.stringify({
        role: 'user',
        content: 'Inspect the Reasonix runtime',
        timestamp: '2026-07-14T01:01:00.000Z',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '',
        reasoning_content: 'I should inspect the files first.',
        tool_calls: [{
          id: 'tool-1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        }],
      }),
      JSON.stringify({
        role: 'tool',
        content: 'README contents',
        tool_call_id: 'tool-1',
        name: 'read_file',
      }),
      JSON.stringify({ role: 'assistant', content: 'The runtime is valid.' }),
    ].join('\n'), 'utf8');
    await writeFile(path.join(currentRoot, 'reasonix-current.acp.json'), JSON.stringify({
      sessionId: 'reasonix-current',
      cwd,
      model: 'deepseek/deepseek-v4',
      title: 'Current Reasonix session',
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:05:00.000Z',
    }), 'utf8');
    await writeFile(legacyPath, JSON.stringify({
      role: 'user',
      content: 'Legacy Reasonix question',
    }), 'utf8');
    await writeFile(path.join(legacyRoot, 'reasonix-legacy.meta.json'), JSON.stringify({
      summary: 'Legacy Reasonix session',
      workspace: path.join(homeDir, 'legacy-workspace'),
      model: 'deepseek-chat',
    }), 'utf8');
    await writeFile(path.join(currentRoot, 'reasonix-current.events.jsonl'), '{}\n', 'utf8');
    await writeFile(path.join(currentRoot, 'reasonix-current.guardian.jsonl'), '{}\n', 'utf8');
    await writeFile(nestedPath, JSON.stringify({
      role: 'user',
      content: 'Nested checkpoint must not be indexed',
    }), 'utf8');

    vi.stubEnv('REASONIX_STATE_HOME', stateHome);
    vi.stubEnv('REASONIX_HOME', '');
    const summaries = await listExternalCliSessions({
      homeDir,
      runtimes: ['reasonix'],
    });
    expect(summaries.map(summary => summary.nativeSessionId).sort()).toEqual([
      'reasonix-current',
      'reasonix-legacy',
    ]);
    expect(summaries.find(summary => summary.nativeSessionId === 'reasonix-current'))
      .toMatchObject({
        runtime: 'reasonix',
        title: 'Current Reasonix session',
        cwd,
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:05:00.000Z',
        messageCount: 6,
      });
    expect(summaries.find(summary => summary.nativeSessionId === 'reasonix-legacy'))
      .toMatchObject({
        runtime: 'reasonix',
        title: 'Legacy Reasonix session',
        cwd: path.join(homeDir, 'legacy-workspace'),
        messageCount: 1,
      });

    const session = await readExternalCliSession(currentPath, {
      homeDir,
      runtimes: ['reasonix'],
    });
    expect(session?.messages.map(message => [message.role, message.text])).toEqual([
      ['system', 'System instructions'],
      ['user', 'Inspect the Reasonix runtime'],
      ['assistant', 'I should inspect the files first.'],
      ['assistant', ''],
      ['tool', 'README contents'],
      ['assistant', 'The runtime is valid.'],
    ]);
    expect(session?.messages[1]?.model).toBe('deepseek/deepseek-v4');
    expect(session?.messages[3]?.tools).toEqual([{
      kind: 'call',
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'README.md' },
    }]);
    expect(session?.messages[4]?.tools).toEqual([{
      kind: 'result',
      id: 'tool-1',
      name: 'read_file',
      output: 'README contents',
    }]);
    await expect(readExternalCliSession(nestedPath, {
      homeDir,
      runtimes: ['reasonix'],
    })).resolves.toBeUndefined();
  });

  it('bounds Reasonix transcript reads by bytes and retained messages', async () => {
    const tempDir = await createTempDir('actoviq-external-reasonix-bounds-');
    const reasonixRoot = path.join(tempDir, 'sessions');
    const sessionPath = path.join(reasonixRoot, 'bounded-reasonix.jsonl');
    const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`,
    }));
    const serialized = lines.join('\n');
    const byteLimit = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, 'utf8');
    await mkdir(reasonixRoot, { recursive: true });
    await writeFile(sessionPath, serialized, 'utf8');
    await writeFile(path.join(reasonixRoot, 'bounded-reasonix.acp.json'), JSON.stringify({
      sessionId: 'bounded-reasonix',
      title: 'Bounded Reasonix session',
    }), 'utf8');

    const byBytes = await readExternalCliSession(sessionPath, {
      reasonixRoot,
      runtimes: ['reasonix'],
      detailMaxBytes: byteLimit,
      detailMaxMessages: 100,
    });
    expect(byBytes?.messages.map(message => message.text)).toEqual(['message-0', 'message-1']);
    expect(byBytes?.summary).toMatchObject({
      nativeSessionId: 'bounded-reasonix',
      title: 'Bounded Reasonix session',
      messageCount: 2,
      truncated: true,
    });
    const canonicalSessionPath = realpathSync.native(sessionPath);
    const checkpointRead = fsSpies.createReadStream.mock.calls.find(
      call => String(call[0]) === canonicalSessionPath || String(call[0]) === sessionPath,
    );
    expect(checkpointRead?.[1]).toMatchObject({ end: byteLimit - 1 });

    const byMessages = await readExternalCliSession(sessionPath, {
      reasonixRoot,
      runtimes: ['reasonix'],
      detailMaxBytes: 1024 * 1024,
      detailMaxMessages: 3,
    });
    expect(byMessages?.messages.map(message => message.text)).toEqual([
      'message-0',
      'message-1',
      'message-2',
    ]);
    expect(byMessages?.summary).toMatchObject({ messageCount: 6, truncated: true });
    expect(fsSpies.readFile).not.toHaveBeenCalled();
  });

  it('rejects nested and symlinked Reasonix checkpoints and ignores symlinked metadata', async () => {
    const tempDir = await createTempDir('actoviq-external-reasonix-safety-');
    const reasonixRoot = path.join(tempDir, 'sessions');
    const safePath = path.join(reasonixRoot, 'safe-session.jsonl');
    const nestedPath = path.join(reasonixRoot, 'nested', 'nested-session.jsonl');
    const outsidePath = path.join(tempDir, 'outside-session.jsonl');
    const linkedPath = path.join(reasonixRoot, 'linked-session.jsonl');
    const outsideMetadata = path.join(tempDir, 'outside-metadata.json');
    const linkedMetadata = path.join(reasonixRoot, 'safe-session.acp.json');
    await mkdir(path.dirname(nestedPath), { recursive: true });
    const checkpoint = JSON.stringify({ role: 'user', content: 'Safe transcript title' });
    await writeFile(safePath, checkpoint, 'utf8');
    await writeFile(nestedPath, checkpoint, 'utf8');
    await writeFile(outsidePath, checkpoint, 'utf8');
    await writeFile(outsideMetadata, JSON.stringify({
      title: 'Symlinked metadata must not be read',
      cwd: tempDir,
    }), 'utf8');

    expect((await listExternalCliSessions({
      reasonixRoot,
      runtimes: ['reasonix'],
    })).map(summary => summary.nativeSessionId)).toEqual(['safe-session']);
    await expect(readExternalCliSession(nestedPath, {
      reasonixRoot,
      runtimes: ['reasonix'],
    })).resolves.toBeUndefined();

    try {
      await symlink(outsidePath, linkedPath, 'file');
      await symlink(outsideMetadata, linkedMetadata, 'file');
      await expect(readExternalCliSession(linkedPath, {
        reasonixRoot,
        runtimes: ['reasonix'],
      })).resolves.toBeUndefined();
      const safeSession = await readExternalCliSession(safePath, {
        reasonixRoot,
        runtimes: ['reasonix'],
      });
      expect(safeSession?.summary).toMatchObject({
        title: 'Safe transcript title',
        cwd: undefined,
      });
      expect((await listExternalCliSessions({
        reasonixRoot,
        runtimes: ['reasonix'],
      })).map(summary => summary.nativeSessionId)).toEqual(['safe-session']);
    } catch (error) {
      if (!isRecordWithCode(error) || (error.code !== 'EPERM' && error.code !== 'EACCES')) {
        throw error;
      }
    }
  });

  it('indexes only top-level CodeWhale SavedSession JSON from canonical and legacy roots', async () => {
    const homeDir = await createTempDir('actoviq-external-codewhale-roots-');
    const workspace = path.join(homeDir, 'workspace');
    const canonicalRoot = path.join(homeDir, '.codewhale', 'sessions');
    const legacyRoot = path.join(homeDir, '.deepseek', 'sessions');
    const canonicalPath = path.join(canonicalRoot, 'whale-session-1.json');
    const legacyPath = path.join(legacyRoot, 'legacy_session_2.json');
    const checkpointPath = path.join(canonicalRoot, 'checkpoints', 'ignored-session.json');
    const invalidNamePath = path.join(canonicalRoot, 'ignored.session.json');
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(canonicalPath, JSON.stringify(codewhaleSavedSession({
      id: 'whale-session-1',
      title: 'Canonical CodeWhale session',
      workspace,
    })), 'utf8');
    await writeFile(legacyPath, JSON.stringify(codewhaleSavedSession({
      id: 'legacy_session_2',
      title: 'Legacy DeepSeek session',
      workspace,
    })), 'utf8');
    await writeFile(checkpointPath, JSON.stringify(codewhaleSavedSession({
      id: 'ignored-session',
      title: 'Ignored checkpoint',
      workspace,
    })), 'utf8');
    await writeFile(invalidNamePath, JSON.stringify(codewhaleSavedSession({
      id: 'ignored-dot-name',
      title: 'Ignored invalid name',
      workspace,
    })), 'utf8');

    const summaries = await listExternalCliSessions({
      homeDir,
      runtimes: ['codewhale'],
    });
    expect(summaries.map(summary => summary.nativeSessionId).sort()).toEqual([
      'legacy_session_2',
      'whale-session-1',
    ]);
    expect(summaries.find(summary => summary.nativeSessionId === 'whale-session-1'))
      .toMatchObject({
        runtime: 'codewhale',
        title: 'Canonical CodeWhale session',
        cwd: workspace,
        createdAt: '2026-07-14T10:00:00.000Z',
        updatedAt: '2026-07-14T10:01:00.000Z',
        messageCount: 0,
      });
  });

  it('prefers CODEWHALE_HOME while allowing an explicit CodeWhale root override', async () => {
    const homeDir = await createTempDir('actoviq-external-codewhale-env-');
    const codewhaleHome = path.join(homeDir, 'configured-codewhale-home');
    const configuredRoot = path.join(codewhaleHome, 'sessions');
    const fallbackRoot = path.join(homeDir, '.codewhale', 'sessions');
    await mkdir(configuredRoot, { recursive: true });
    await mkdir(fallbackRoot, { recursive: true });
    await writeFile(
      path.join(configuredRoot, 'configured-session.json'),
      JSON.stringify(codewhaleSavedSession({
        id: 'configured-session',
        title: 'Configured home',
        workspace: homeDir,
      })),
      'utf8',
    );
    await writeFile(
      path.join(fallbackRoot, 'fallback-session.json'),
      JSON.stringify(codewhaleSavedSession({
        id: 'fallback-session',
        title: 'Fallback home',
        workspace: homeDir,
      })),
      'utf8',
    );

    vi.stubEnv('CODEWHALE_HOME', codewhaleHome);
    expect((await listExternalCliSessions({ homeDir, runtimes: ['codewhale'] }))
      .map(summary => summary.nativeSessionId)).toEqual(['configured-session']);
    expect((await listExternalCliSessions({
      homeDir,
      codewhaleRoot: fallbackRoot,
      runtimes: ['codewhale'],
    })).map(summary => summary.nativeSessionId)).toEqual(['fallback-session']);
  });

  it('normalizes CodeWhale text, thinking, tool, result, and server-tool blocks', async () => {
    const tempDir = await createTempDir('actoviq-external-codewhale-content-');
    const codewhaleRoot = path.join(tempDir, 'sessions');
    const sessionPath = path.join(codewhaleRoot, 'content-session.json');
    await mkdir(codewhaleRoot, { recursive: true });
    await writeFile(sessionPath, JSON.stringify(codewhaleSavedSession({
      id: 'content-session',
      title: 'CodeWhale content blocks',
      workspace: path.join(tempDir, 'workspace'),
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect the runtime' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Check the project first' },
            { type: 'text', text: 'Running two tools.' },
            { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/index.ts' } },
            { type: 'server_tool_use', id: 'server-1', name: 'web_search', input: { q: 'CodeWhale' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'export {}',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'server-1',
              content: '',
              content_blocks: [{ type: 'text', text: 'server result' }],
              is_error: true,
            },
          ],
        },
      ],
    })), 'utf8');

    const session = await readExternalCliSession(sessionPath, {
      codewhaleRoot,
      runtimes: ['codewhale'],
    });
    expect(session?.summary).toMatchObject({
      runtime: 'codewhale',
      nativeSessionId: 'content-session',
      title: 'CodeWhale content blocks',
      messageCount: 3,
    });
    expect(session?.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'Inspect the runtime'],
      ['assistant', 'Check the project first\nRunning two tools.'],
      ['tool', 'export {}\nserver result'],
    ]);
    expect(session?.messages[1]).toMatchObject({
      model: 'deepseek-reasoner',
      tools: [
        {
          kind: 'call',
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'src/index.ts' },
        },
        {
          kind: 'call',
          id: 'server-1',
          name: 'web_search',
          input: { q: 'CodeWhale' },
        },
      ],
    });
    expect(session?.messages[2]?.tools).toEqual([
      {
        kind: 'result',
        id: 'tool-1',
        output: 'export {}',
        isError: false,
      },
      {
        kind: 'result',
        id: 'server-1',
        output: 'server result',
        isError: true,
      },
    ]);
  });

  it('bounds CodeWhale SavedSession reads by bytes and messages without whole-file reads', async () => {
    const tempDir = await createTempDir('actoviq-external-codewhale-bounds-');
    const codewhaleRoot = path.join(tempDir, 'sessions');
    const sessionPath = path.join(codewhaleRoot, 'bounded-session.json');
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message-${index}` }],
    }));
    const serialized = JSON.stringify(codewhaleSavedSession({
      id: 'bounded-session',
      title: 'Bounded CodeWhale session',
      workspace: tempDir,
      messages,
      messageCount: messages.length,
    }));
    const thirdMessageStart = serialized.indexOf(JSON.stringify(messages[2]));
    expect(thirdMessageStart).toBeGreaterThan(0);
    await mkdir(codewhaleRoot, { recursive: true });
    await writeFile(sessionPath, serialized, 'utf8');

    fsSpies.createReadStream.mockClear();
    const byBytes = await readExternalCliSession(sessionPath, {
      codewhaleRoot,
      runtimes: ['codewhale'],
      detailMaxBytes: thirdMessageStart,
      detailMaxMessages: 100,
    });
    expect(byBytes?.messages.map(message => message.text)).toEqual(['message-0', 'message-1']);
    expect(byBytes?.summary).toMatchObject({
      title: 'Bounded CodeWhale session',
      messageCount: 20,
      truncated: true,
    });
    expect(fsSpies.createReadStream).toHaveBeenCalledTimes(1);
    expect(fsSpies.createReadStream.mock.calls[0]?.[1]).toMatchObject({
      end: thirdMessageStart - 1,
    });

    const byMessages = await readExternalCliSession(sessionPath, {
      codewhaleRoot,
      runtimes: ['codewhale'],
      detailMaxBytes: 1024 * 1024,
      detailMaxMessages: 3,
    });
    expect(byMessages?.messages.map(message => message.text)).toEqual([
      'message-0',
      'message-1',
      'message-2',
    ]);
    expect(byMessages?.summary).toMatchObject({ messageCount: 20, truncated: true });
    expect(fsSpies.readFile).not.toHaveBeenCalled();
  });

  it('rejects nested and symlinked CodeWhale session files', async () => {
    const tempDir = await createTempDir('actoviq-external-codewhale-safety-');
    const codewhaleRoot = path.join(tempDir, 'sessions');
    const nestedPath = path.join(codewhaleRoot, 'checkpoints', 'nested.json');
    const outsidePath = path.join(tempDir, 'outside.json');
    const symlinkPath = path.join(codewhaleRoot, 'linked.json');
    const fixture = JSON.stringify(codewhaleSavedSession({
      id: 'unsafe-session',
      title: 'Unsafe session',
      workspace: tempDir,
    }));
    await mkdir(path.dirname(nestedPath), { recursive: true });
    await writeFile(nestedPath, fixture, 'utf8');
    await writeFile(outsidePath, fixture, 'utf8');

    expect(await listExternalCliSessions({
      codewhaleRoot,
      runtimes: ['codewhale'],
    })).toEqual([]);
    await expect(readExternalCliSession(nestedPath, {
      codewhaleRoot,
      runtimes: ['codewhale'],
    })).resolves.toBeUndefined();

    try {
      await symlink(outsidePath, symlinkPath, 'file');
      await expect(readExternalCliSession(symlinkPath, {
        codewhaleRoot,
        runtimes: ['codewhale'],
      })).resolves.toBeUndefined();
      expect(await listExternalCliSessions({
        codewhaleRoot,
        runtimes: ['codewhale'],
      })).toEqual([]);
    } catch (error) {
      if (!isRecordWithCode(error) || (error.code !== 'EPERM' && error.code !== 'EACCES')) {
        throw error;
      }
    }
  });

  it('matches CodeWhale official redacted session fingerprints', () => {
    expect(codewhaleRedactedIdentifierForLog('')).toBe('<redacted:empty>');
    expect(codewhaleRedactedIdentifierForLog('session-123'))
      .toBe('<redacted:b3e476ab1347ca63>');
    expect(codewhaleRedactedIdentifierForLog('会话-α'))
      .toBe('<redacted:583550d82e76b6e6>');
  });

  it('resolves a CodeWhale fingerprint only within the matching cwd and mtime window', async () => {
    const tempDir = await createTempDir('actoviq-external-codewhale-correlation-');
    const codewhaleRoot = path.join(tempDir, 'sessions');
    const workspace = path.join(tempDir, 'workspace');
    const nativeSessionId = 'correlated-native-session';
    const sessionPath = path.join(codewhaleRoot, `${nativeSessionId}.json`);
    const modifiedAt = Date.now();
    await mkdir(codewhaleRoot, { recursive: true });
    await writeFile(sessionPath, JSON.stringify(codewhaleSavedSession({
      id: nativeSessionId,
      title: 'Correlated session',
      workspace,
    })), 'utf8');
    await utimes(sessionPath, new Date(modifiedAt), new Date(modifiedAt));

    const correlation = {
      correlationHint: codewhaleRedactedIdentifierForLog(nativeSessionId),
      codewhaleRoot,
      cwd: workspace,
      startedAtMs: modifiedAt - 1_000,
      finishedAtMs: modifiedAt + 1_000,
      clockSkewMs: 0,
    };
    await expect(resolveCodewhaleNativeSessionId(correlation)).resolves.toBe(nativeSessionId);
    await expect(resolveCodewhaleNativeSessionId({
      ...correlation,
      cwd: path.join(tempDir, 'other-workspace'),
    })).resolves.toBeUndefined();
    await expect(resolveCodewhaleNativeSessionId({
      ...correlation,
      startedAtMs: modifiedAt + 5_000,
      finishedAtMs: modifiedAt + 6_000,
    })).resolves.toBeUndefined();
  });

  it('rejects reads outside the configured session roots', async () => {
    const tempDir = await createTempDir('actoviq-external-path-safety-');
    const claudeRoot = path.join(tempDir, '.claude', 'projects');
    const codexRoot = path.join(tempDir, '.codex', 'sessions');
    const piRoot = path.join(tempDir, '.pi', 'agent', 'sessions');
    const codewhaleRoot = path.join(tempDir, '.codewhale', 'sessions');
    const outsidePath = path.join(tempDir, 'outside.jsonl');
    await mkdir(claudeRoot, { recursive: true });
    await mkdir(codexRoot, { recursive: true });
    await writeFile(outsidePath, '{}\n', 'utf8');

    await expect(readExternalCliSession(outsidePath, {
      claudeRoot,
      codexRoot,
      piRoot,
      codewhaleRoot,
    })).rejects.toMatchObject({
      code: 'EXTERNAL_CLI_SESSION_PATH_UNSAFE',
    });
  });

  it('bounds large summary reads and reuses the mtime-and-size cache', async () => {
    const tempDir = await createTempDir('actoviq-external-large-summary-');
    const claudeRoot = path.join(tempDir, '.claude', 'projects');
    const codexRoot = path.join(tempDir, '.codex', 'sessions');
    const piRoot = path.join(tempDir, '.pi', 'agent', 'sessions');
    const codewhaleRoot = path.join(tempDir, '.codewhale', 'sessions');
    const nativeSessionId = 'bbbbbbbb-1111-2222-3333-cccccccccccc';
    const sessionPath = path.join(claudeRoot, `${nativeSessionId}.jsonl`);
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({
      type: 'user',
      sessionId: nativeSessionId,
      cwd: tempDir,
      timestamp: '2026-07-13T10:00:00.000Z',
      message: { role: 'user', content: 'Large transcript title' },
    })}\n`, 'utf8');
    await truncate(sessionPath, 32 * 1024 * 1024);

    const options = {
      claudeRoot,
      codexRoot,
      piRoot,
      codewhaleRoot,
      summaryMaxBytes: 4 * 1024,
    };
    const first = await listExternalCliSessions(options);
    expect(first).toEqual([expect.objectContaining({
      nativeSessionId,
      title: 'Large transcript title',
      messageCount: 1,
      truncated: true,
    })]);
    expect(fsSpies.readFile).not.toHaveBeenCalled();
    expect(fsSpies.createReadStream).toHaveBeenCalledTimes(1);
    expect(fsSpies.createReadStream.mock.calls[0]?.[1]).toMatchObject({
      end: (4 * 1024) - 1,
    });

    const cached = await listExternalCliSessions(options);
    expect(cached).toEqual(first);
    expect(fsSpies.createReadStream).toHaveBeenCalledTimes(1);

    await appendFile(sessionPath, '\n', 'utf8');
    await listExternalCliSessions(options);
    expect(fsSpies.createReadStream).toHaveBeenCalledTimes(2);
  });

  it('sorts and paginates file metadata before opening transcript streams', async () => {
    const tempDir = await createTempDir('actoviq-external-metadata-order-');
    const claudeRoot = path.join(tempDir, '.claude', 'projects');
    const codexRoot = path.join(tempDir, '.codex', 'sessions');
    const piRoot = path.join(tempDir, '.pi', 'agent', 'sessions');
    const codewhaleRoot = path.join(tempDir, '.codewhale', 'sessions');
    await mkdir(claudeRoot, { recursive: true });

    const ids = [
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ];
    for (const [index, id] of ids.entries()) {
      const filePath = path.join(claudeRoot, `${id}.jsonl`);
      await writeFile(filePath, `${JSON.stringify({
        type: 'user',
        sessionId: id,
        message: { role: 'user', content: `Session ${index + 1}` },
      })}\n`, 'utf8');
      const modifiedAt = new Date(`2026-07-13T10:00:0${index}.000Z`);
      await utimes(filePath, modifiedAt, modifiedAt);
    }

    const summaries = await listExternalCliSessions({
      claudeRoot,
      codexRoot,
      piRoot,
      codewhaleRoot,
      offset: 1,
      limit: 1,
    });
    expect(summaries.map(summary => summary.nativeSessionId)).toEqual([ids[1]]);
    expect(fsSpies.createReadStream).toHaveBeenCalledTimes(1);
  });

  it('streams details with byte and message limits instead of loading the whole JSONL', async () => {
    const tempDir = await createTempDir('actoviq-external-detail-limits-');
    const claudeRoot = path.join(tempDir, '.claude', 'projects');
    const codexRoot = path.join(tempDir, '.codex', 'sessions');
    const piRoot = path.join(tempDir, '.pi', 'agent', 'sessions');
    const nativeSessionId = 'dddddddd-1111-2222-3333-eeeeeeeeeeee';
    const sessionPath = path.join(claudeRoot, `${nativeSessionId}.jsonl`);
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(sessionPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      type: index % 2 === 0 ? 'user' : 'assistant',
      sessionId: nativeSessionId,
      timestamp: `2026-07-13T11:00:${String(index).padStart(2, '0')}.000Z`,
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
      },
    })).join('\n'), 'utf8');

    const byMessageCount = await readExternalCliSession(sessionPath, {
      claudeRoot,
      codexRoot,
      piRoot,
      detailMaxBytes: 1024 * 1024,
      detailMaxMessages: 5,
    });
    expect(byMessageCount?.messages.map(message => message.text)).toEqual([
      'message-0',
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(byMessageCount?.truncated).toBe(true);
    expect(byMessageCount?.summary).toMatchObject({ messageCount: 5, truncated: true });

    const byBytes = await readExternalCliSession(sessionPath, {
      claudeRoot,
      codexRoot,
      piRoot,
      detailMaxBytes: 300,
      detailMaxMessages: 100,
    });
    expect(byBytes?.messages.length).toBeGreaterThan(0);
    expect(byBytes?.messages.length).toBeLessThan(20);
    expect(byBytes?.truncated).toBe(true);
    expect(fsSpies.readFile).not.toHaveBeenCalled();
  });
});
