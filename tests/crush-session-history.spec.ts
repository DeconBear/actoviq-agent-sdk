import { describe, expect, it, vi } from 'vitest';

import {
  createCrushSessionReference,
  defaultCrushHistoryCommandRunner,
  isCrushSessionReference,
  listCrushSessionHistory,
  parseCrushSessionReference,
  parseCrushSessionReferenceDetails,
  readCrushSessionHistory,
  type CrushHistoryCommandRequest,
  type CrushHistoryCommandRunner,
} from '../src/parity/crushSessionHistory.js';

const SESSION_ONE = '11111111-1111-4111-8111-111111111111';
const SESSION_TWO = '22222222-2222-4222-8222-222222222222';

function commandResult(stdout: unknown, exitCode = 0) {
  return {
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    exitCode,
  };
}

describe('Crush session history', () => {
  it('lists official JSON summaries using safe virtual references', async () => {
    const requests: CrushHistoryCommandRequest[] = [];
    const commandRunner: CrushHistoryCommandRunner = async request => {
      requests.push(request);
      return commandResult([
        {
          id: 'short-one',
          uuid: SESSION_ONE,
          title: ' First\nconversation ',
          created: '2026-07-10T10:00:00Z',
          modified: '2026-07-10T11:00:00Z',
        },
        {
          id: 'short-two',
          uuid: SESSION_TWO,
          title: 'Second conversation',
          created: '2026-07-11T10:00:00Z',
          modified: '2026-07-12T11:00:00Z',
        },
        {
          id: 'unsafe',
          uuid: '--continue',
          title: 'must be ignored',
          created: '2026-07-13T10:00:00Z',
          modified: '2026-07-13T11:00:00Z',
        },
      ]);
    };

    const sessions = await listCrushSessionHistory({
      executable: 'crush-test',
      cwd: process.cwd(),
      timeoutMs: 1_234,
      maxOutputBytes: 65_536,
      commandRunner,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      executable: 'crush-test',
      args: ['session', 'list', '--json'],
      cwd: process.cwd(),
      timeoutMs: 1_234,
      maxOutputBytes: 65_536,
      shell: false,
    });
    expect(sessions.map(session => session.nativeSessionId)).toEqual([
      SESSION_TWO,
      SESSION_ONE,
    ]);
    expect(sessions[1]).toMatchObject({
      runtime: 'crush',
      title: 'First conversation',
      cwd: process.cwd(),
      messageCount: 0,
      messageCountKnown: false,
    });
    for (const session of sessions) {
      expect(isCrushSessionReference(session.path)).toBe(true);
      expect(session.path).not.toContain(session.nativeSessionId);
      expect(parseCrushSessionReference(session.path)).toBe(session.nativeSessionId);
    }
  });

  it('reads an exact session and preserves text, reasoning, and tool metadata', async () => {
    const requests: CrushHistoryCommandRequest[] = [];
    const commandRunner: CrushHistoryCommandRunner = async request => {
      requests.push(request);
      return commandResult({
        meta: {
          id: 'short-one',
          uuid: SESSION_ONE,
          title: 'Managed Crush session',
          created: '2026-07-10T10:00:00Z',
          modified: '2026-07-10T12:00:00Z',
          prompt_tokens: 12,
          completion_tokens: 24,
        },
        messages: [
          {
            id: 'message-user',
            role: 'user',
            created: '2026-07-10T10:00:01Z',
            parts: [{ type: 'text', text: 'Inspect the project' }],
          },
          {
            id: 'message-assistant',
            role: 'assistant',
            created: '2026-07-10T10:00:02Z',
            model: 'claude-sonnet',
            provider: 'anthropic',
            parts: [
              { type: 'reasoning', thinking: 'I should inspect it.' },
              { type: 'text', text: 'I will read README.md.' },
              {
                type: 'tool_call',
                tool_call_id: 'tool-one',
                name: 'view',
                input: '{"path":"README.md"}',
              },
            ],
          },
          {
            id: 'message-tool',
            role: 'tool',
            created: '2026-07-10T10:00:03Z',
            parts: [{
              type: 'tool_result',
              tool_call_id: 'tool-one',
              name: 'view',
              content: 'README contents',
              is_error: false,
            }],
          },
          {
            id: 'message-finish',
            role: 'assistant',
            created: '2026-07-10T10:00:04Z',
            parts: [{ type: 'finish', reason: 'end_turn' }],
          },
        ],
      });
    };
    const reference = createCrushSessionReference(SESSION_ONE);

    const session = await readCrushSessionHistory(reference, {
      cwd: process.cwd(),
      commandRunner,
    });

    expect(requests[0]?.args).toEqual([
      'session',
      'show',
      SESSION_ONE,
      '--json',
    ]);
    expect(requests[0]?.args).not.toContain('--continue');
    expect(session?.summary).toMatchObject({
      runtime: 'crush',
      nativeSessionId: SESSION_ONE,
      title: 'Managed Crush session',
      messageCount: 4,
      messageCountKnown: true,
      path: reference,
    });
    expect(session?.messages).toEqual([
      {
        role: 'user',
        text: 'Inspect the project',
        timestamp: '2026-07-10T10:00:01.000Z',
        model: undefined,
      },
      {
        role: 'assistant',
        text: 'I should inspect it.\nI will read README.md.',
        timestamp: '2026-07-10T10:00:02.000Z',
        model: 'claude-sonnet',
        tools: [{
          kind: 'call',
          id: 'tool-one',
          name: 'view',
          input: { path: 'README.md' },
        }],
      },
      {
        role: 'tool',
        text: 'README contents',
        timestamp: '2026-07-10T10:00:03.000Z',
        model: undefined,
        tools: [{
          kind: 'result',
          id: 'tool-one',
          name: 'view',
          output: 'README contents',
          isError: false,
        }],
      },
    ]);
  });

  it('binds managed-profile references to the exact profile identity', async () => {
    const managedProfileId = 'a'.repeat(64);
    const otherProfileId = 'b'.repeat(64);
    const commandRunner = vi.fn<CrushHistoryCommandRunner>(async request =>
      request.args[1] === 'list'
        ? commandResult([{
            uuid: SESSION_ONE,
            title: 'Managed profile session',
            created: '2026-07-10T10:00:00Z',
            modified: '2026-07-10T11:00:00Z',
          }])
        : commandResult({
            meta: {
              uuid: SESSION_ONE,
              title: 'Managed profile session',
              created: '2026-07-10T10:00:00Z',
              modified: '2026-07-10T11:00:00Z',
            },
            messages: [],
          }),
    );
    const sessions = await listCrushSessionHistory({
      managedProfileId,
      env: { CRUSH_GLOBAL_DATA: '/managed/data' },
      commandRunner,
    });
    const reference = sessions[0]?.path ?? '';

    expect(parseCrushSessionReference(reference)).toBe(SESSION_ONE);
    expect(parseCrushSessionReferenceDetails(reference)).toEqual({
      nativeSessionId: SESSION_ONE,
      managedProfileId,
    });
    await expect(readCrushSessionHistory(reference, { commandRunner }))
      .resolves.toBeUndefined();
    await expect(readCrushSessionHistory(reference, {
      managedProfileId: otherProfileId,
      commandRunner,
    })).resolves.toBeUndefined();
    expect(commandRunner).toHaveBeenCalledTimes(1);

    await expect(readCrushSessionHistory(reference, {
      managedProfileId,
      env: { CRUSH_GLOBAL_DATA: '/managed/data' },
      commandRunner,
    })).resolves.toMatchObject({
      summary: { nativeSessionId: SESSION_ONE, path: reference },
    });
    expect(commandRunner.mock.calls[1]?.[0].env.CRUSH_GLOBAL_DATA)
      .toBe('/managed/data');
  });

  it('marks bounded detail reads as truncated without losing the native count', async () => {
    const commandRunner: CrushHistoryCommandRunner = async () => commandResult({
      meta: {
        uuid: SESSION_ONE,
        title: 'Long session',
        created: '2026-07-10T10:00:00Z',
        modified: '2026-07-10T12:00:00Z',
      },
      messages: [
        { role: 'user', created: '2026-07-10T10:00:01Z', parts: [{ type: 'text', text: '1' }] },
        { role: 'assistant', created: '2026-07-10T10:00:02Z', parts: [{ type: 'text', text: '2' }] },
        { role: 'user', created: '2026-07-10T10:00:03Z', parts: [{ type: 'text', text: '3' }] },
      ],
    });

    const session = await readCrushSessionHistory(
      createCrushSessionReference(SESSION_ONE),
      { commandRunner, maxMessages: 2 },
    );

    expect(session?.truncated).toBe(true);
    expect(session?.summary).toMatchObject({ messageCount: 3, truncated: true });
    expect(session?.messages.map(message => message.text)).toEqual(['1', '2']);
  });

  it('never passes raw, malformed, or mismatched ids to the command runner', async () => {
    const commandRunner = vi.fn<CrushHistoryCommandRunner>();
    await expect(readCrushSessionHistory(SESSION_ONE, { commandRunner }))
      .resolves.toBeUndefined();
    await expect(readCrushSessionHistory('actoviq-crush-session:v1:../../bad', {
      commandRunner,
    })).resolves.toBeUndefined();
    expect(commandRunner).not.toHaveBeenCalled();
    expect(() => createCrushSessionReference('--continue'))
      .toThrow(/exact UUID/u);
    expect(() => createCrushSessionReference(SESSION_ONE, '../../outside'))
      .toThrow(/exact managed profile id/u);
    expect(parseCrushSessionReferenceDetails(
      `actoviq-crush-session:v2:${Buffer.from('../../outside').toString('base64url')}`,
    )).toBeUndefined();

    const mismatchedRunner: CrushHistoryCommandRunner = async () => commandResult({
      meta: {
        uuid: SESSION_TWO,
        title: 'Wrong session',
        created: '2026-07-10T10:00:00Z',
        modified: '2026-07-10T12:00:00Z',
      },
      messages: [],
    });
    await expect(readCrushSessionHistory(
      createCrushSessionReference(SESSION_ONE),
      { commandRunner: mismatchedRunner },
    )).rejects.toThrow(/exact requested session/u);
  });

  it('enforces the output bound even for an injected runner', async () => {
    const commandRunner: CrushHistoryCommandRunner = async () => commandResult('x'.repeat(65));
    await expect(listCrushSessionHistory({
      commandRunner,
      maxOutputBytes: 64,
    })).rejects.toThrow(/safety limit/u);
  });

  it('bounds and terminates excessive output in the default shell-free runner', async () => {
    await expect(defaultCrushHistoryCommandRunner({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(2048))'],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 5_000,
      maxOutputBytes: 128,
      shell: false,
    })).rejects.toThrow(/safety limit/u);
  });

  it('times out and terminates a hung default-runner command', async () => {
    await expect(defaultCrushHistoryCommandRunner({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 100,
      maxOutputBytes: 128,
      shell: false,
    })).rejects.toThrow(/timed out/u);
  });
});
