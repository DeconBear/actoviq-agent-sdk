import { describe, expect, it } from 'vitest';

import {
  createReasonixAcpSession,
  type CreateReasonixAcpSessionOptions,
  type ReasonixAcpJsonRpcRecord,
} from '../src/parity/reasonixAcpSession.js';

const baseOptions: CreateReasonixAcpSessionOptions = {
  prompt: 'Inspect the graph',
  cwd: 'C:\\workspace',
  permissionMode: 'default',
};

function response(id: number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

function onlyOutbound(records: ReasonixAcpJsonRpcRecord[]): ReasonixAcpJsonRpcRecord {
  expect(records).toHaveLength(1);
  return records[0] as ReasonixAcpJsonRpcRecord;
}

function openNewSession(
  options: Partial<CreateReasonixAcpSessionOptions> = {},
): {
  session: ReturnType<typeof createReasonixAcpSession>;
  promptId: number;
} {
  const session = createReasonixAcpSession({ ...baseOptions, ...options });
  const initialize = onlyOutbound(session.start());
  expect(initialize).toMatchObject({ id: 1, method: 'initialize' });

  const opening = session.handle(response(1, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  }));
  expect(onlyOutbound(opening.outbound)).toMatchObject({
    id: 2,
    method: 'session/new',
    params: { cwd: baseOptions.cwd },
  });

  const opened = session.handle(response(2, { sessionId: 'reasonix-session-1' }));
  expect(opened.nativeSessionId).toBe('reasonix-session-1');
  expect(opened.events).toEqual([
    expect.objectContaining({
      type: 'system',
      subtype: 'init',
      session_id: 'reasonix-session-1',
    }),
  ]);
  const prompt = onlyOutbound(opened.outbound);
  expect(prompt).toMatchObject({
    method: 'session/prompt',
    params: {
      sessionId: 'reasonix-session-1',
      prompt: [{ type: 'text', text: baseOptions.prompt }],
    },
  });
  return { session, promptId: Number(prompt.id) };
}

describe('Reasonix ACP session state machine', () => {
  it('correlates initialize, new-session, and prompt responses by request id', () => {
    const session = createReasonixAcpSession(baseOptions);
    const initialize = onlyOutbound(session.start());
    expect(initialize).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'actoviq-agent-sdk', title: 'Hadamard' },
        clientCapabilities: {},
      },
    });
    expect(session.start()).toEqual([]);

    expect(session.handle(response(99, {}))).toEqual({
      outbound: [],
      events: [],
      done: false,
    });

    const opening = session.handle(response(1, { protocolVersion: 1 }));
    expect(onlyOutbound(opening.outbound)).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: baseOptions.cwd },
    });

    const opened = session.handle(response(2, { sessionId: 'sess-new' }));
    expect(opened.done).toBe(false);
    expect(opened.nativeSessionId).toBe('sess-new');
    expect(onlyOutbound(opened.outbound)).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'sess-new',
        prompt: [{ type: 'text', text: baseOptions.prompt }],
      },
    });
  });

  it('loads an exact native session and applies only advertised configuration options', () => {
    const session = createReasonixAcpSession({
      ...baseOptions,
      nativeSessionId: 'persisted-uuid',
      model: 'deepseek/deepseek-v4',
      effort: 'high',
      maxBudgetUsd: 4.5,
    });
    session.start();
    const loading = session.handle(response(1, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }));
    expect(onlyOutbound(loading.outbound)).toMatchObject({
      id: 2,
      method: 'session/load',
      params: { sessionId: 'persisted-uuid', cwd: baseOptions.cwd },
    });
    expect(session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'persisted-uuid',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed history' },
        },
      },
    }).events).toEqual([]);

    const loaded = session.handle(response(2, {
      configOptions: [
        { id: 'model', currentValue: 'deepseek/old' },
        { id: 'effort', currentValue: 'medium' },
        { id: 'budget_usd', currentValue: '2' },
      ],
    }));
    expect(onlyOutbound(loaded.outbound)).toMatchObject({
      id: 3,
      method: 'session/set_config_option',
      params: {
        sessionId: 'persisted-uuid',
        configId: 'model',
        value: 'deepseek/deepseek-v4',
      },
    });

    const effort = session.handle(response(3, {}));
    expect(onlyOutbound(effort.outbound)).toMatchObject({
      id: 4,
      method: 'session/set_config_option',
      params: { configId: 'effort', value: 'high' },
    });
    const budget = session.handle(response(4, {}));
    expect(onlyOutbound(budget.outbound)).toMatchObject({
      id: 5,
      method: 'session/set_config_option',
      params: { configId: 'budget_usd', value: '4.5' },
    });
    const prompting = session.handle(response(5, {}));
    expect(onlyOutbound(prompting.outbound)).toMatchObject({
      id: 6,
      method: 'session/prompt',
      params: { sessionId: 'persisted-uuid' },
    });
  });

  it('normalizes message, thought, tool, and completed prompt records', () => {
    const { session, promptId } = openNewSession();

    const text = session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' },
        },
      },
    });
    expect(text.events).toEqual([
      expect.objectContaining({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello ' },
        },
      }),
    ]);

    const thought = session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'checking' },
        },
      },
    });
    expect(thought.events[0]).toMatchObject({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'checking' },
      },
    });

    const tool = session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'read_file',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'README.md' },
        },
      },
    });
    expect(tool.events).toEqual([
      expect.objectContaining({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'read_file',
            input: { path: 'README.md' },
          }],
        },
      }),
    ]);

    const toolResult = session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
          content: [{
            type: 'content',
            content: { type: 'text', text: 'file contents' },
          }],
        },
      },
    });
    expect(toolResult.events).toEqual([
      expect.objectContaining({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'file contents',
            is_error: false,
          }],
        },
      }),
    ]);

    session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        },
      },
    });
    const completed = session.handle(response(promptId, { stopReason: 'end_turn' }));
    expect(completed.done).toBe(true);
    expect(completed.events).toEqual([
      expect.objectContaining({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      }),
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Hello world',
        stop_reason: 'end_turn',
      }),
    ]);
  });

  it.each([
    { status: 'completed', content: 'final output', isError: false },
    { status: 'failed', content: 'final failure', isError: true },
  ] as const)(
    'waits for a terminal $status tool update before emitting its result',
    ({ status, content, isError }) => {
      const { session } = openNewSession();
      const update = (nextStatus: string, text: string) => session.handle({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'reasonix-session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-progress-1',
            status: nextStatus,
            content: [{
              type: 'content',
              content: { type: 'text', text },
            }],
          },
        },
      });

      expect(update('in_progress', 'partial output').events).toEqual([]);
      expect(update(status, content).events).toEqual([
        expect.objectContaining({
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-progress-1',
              content,
              is_error: isError,
            }],
          },
        }),
      ]);
    },
  );

  it.each([
    { mode: 'bypassPermissions', kind: 'execute', selected: 'allow' },
    { mode: 'acceptEdits', kind: 'edit', selected: 'allow' },
    { mode: 'acceptEdits', kind: 'execute', selected: 'reject' },
    { mode: 'default', kind: 'edit', selected: 'reject' },
    { mode: 'plan', kind: 'edit', selected: 'reject' },
    { mode: 'dontAsk', kind: 'edit', selected: 'reject' },
  ] as const)(
    'uses safe one-shot permission decisions for $mode and $kind',
    ({ mode, kind, selected }) => {
      const { session } = openNewSession({ permissionMode: mode });
      const result = session.handle(request(41, 'session/request_permission', {
        sessionId: 'reasonix-session-1',
        toolCall: { toolCallId: 'gate-1', title: 'operation', kind },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      }));
      expect(result.events).toEqual([
        expect.objectContaining({
          type: 'system',
          subtype: 'permission_request',
          session_id: 'reasonix-session-1',
          decision: 'selected',
          option_id: selected,
        }),
      ]);
      expect(result.done).toBe(false);
      expect(onlyOutbound(result.outbound)).toEqual({
        jsonrpc: '2.0',
        id: 41,
        result: { outcome: { outcome: 'selected', optionId: selected } },
      });
    },
  );

  it('cancels the exact active session once and ignores unrelated notifications', () => {
    const { session } = openNewSession();
    expect(session.handle({
      jsonrpc: '2.0',
      method: 'session/unknown_notification',
      params: {},
    })).toMatchObject({ outbound: [], events: [], done: false });

    expect(session.cancel()).toEqual([{
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'reasonix-session-1' },
    }]);
    expect(session.cancel()).toEqual([]);
  });

  it('starts another prompt turn without reinitializing or loading the native session', () => {
    const { session, promptId } = openNewSession();
    session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'first' },
        },
      },
    });
    expect(session.handle(response(promptId, { stopReason: 'end_turn' })).done).toBe(true);
    expect(session.canContinue()).toBe(true);

    const next = session.nextTurn({
      prompt: 'second turn',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
    expect(next.done).toBe(false);
    expect(next.events).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'init',
        session_id: 'reasonix-session-1',
      }),
    ]);
    expect(onlyOutbound(next.outbound)).toMatchObject({
      id: promptId + 1,
      method: 'session/prompt',
      params: {
        sessionId: 'reasonix-session-1',
        prompt: [{ type: 'text', text: 'second turn' }],
      },
    });
  });

  it('responds to unknown requests without disturbing the pending prompt', () => {
    const { session, promptId } = openNewSession();
    const unknown = session.handle(request(77, 'terminal/create', {}));
    expect(onlyOutbound(unknown.outbound)).toEqual({
      jsonrpc: '2.0',
      id: 77,
      error: { code: -32601, message: 'Method not found: terminal/create' },
    });
    expect(session.handle(response(promptId, { stopReason: 'end_turn' })).done).toBe(true);
  });

  it('turns matching JSON-RPC and prompt failures into canonical error results', () => {
    const initializing = createReasonixAcpSession(baseOptions);
    initializing.start();
    expect(initializing.handle({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'missing credentials' },
    })).toMatchObject({
      done: true,
      events: [{
        type: 'result',
        subtype: 'error',
        session_id: '',
        is_error: true,
        result: 'missing credentials',
        stop_reason: 'error',
        num_turns: 1,
      }],
    });

    const { session, promptId } = openNewSession();
    session.handle({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'reasonix-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '[error]' },
          metadata: { error: { name: 'ProviderError', message: 'provider failed' } },
        },
      },
    });
    const failed = session.handle(response(promptId, { stopReason: 'error' }));
    expect(failed).toMatchObject({
      done: true,
      nativeSessionId: 'reasonix-session-1',
      events: [
        expect.objectContaining({ type: 'assistant' }),
        expect.objectContaining({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'provider failed',
          stop_reason: 'error',
        }),
      ],
    });
  });

  it('rejects persisted resume when the agent explicitly reports no load support', () => {
    const session = createReasonixAcpSession({
      ...baseOptions,
      nativeSessionId: 'old-session',
    });
    session.start();
    const unsupported = session.handle(response(1, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
    }));
    expect(unsupported.done).toBe(true);
    expect(unsupported.outbound).toEqual([]);
    expect(unsupported.events[0]).toMatchObject({
      type: 'result',
      subtype: 'error',
      result: 'This Reasonix ACP version cannot load persisted sessions.',
    });
  });

  it('validates an explicit budget before starting the protocol', () => {
    expect(() => createReasonixAcpSession({
      ...baseOptions,
      maxBudgetUsd: Number.NaN,
    })).toThrow('maxBudgetUsd must be a finite non-negative number.');
  });
});
