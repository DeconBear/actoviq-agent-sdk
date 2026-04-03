import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createActoviqComputerUseToolkit,
  createAgentSdk,
  tool,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'end_turn' | 'tool_use' = 'end_turn'): Message {
  messageCounter += 1;
  return {
    id: `msg_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 5,
    },
  } as Message;
}

class MockStream implements ModelStreamHandle {
  constructor(
    private readonly events: MessageStreamEvent[],
    private readonly message: Message,
  ) {}

  async finalMessage(): Promise<Message> {
    return this.message;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class MockModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];
  readonly streamCalls: ModelRequest[] = [];

  constructor(
    private readonly handlers: {
      create?: (request: ModelRequest, index: number) => Promise<Message> | Message;
      stream?: (request: ModelRequest, index: number) => {
        events: MessageStreamEvent[];
        message: Message;
      };
    },
  ) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    if (!this.handlers.create) {
      throw new Error('Unexpected createMessage call.');
    }
    return this.handlers.create(request, this.createCalls.length - 1);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    this.streamCalls.push(structuredClone(request));
    if (!this.handlers.stream) {
      throw new Error('Unexpected streamMessage call.');
    }
    const response = this.handlers.stream(request, this.streamCalls.length - 1);
    return new MockStream(response.events, response.message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Actoviq advanced parity features', () => {
  it('applies permission rules before mutating tools execute', async () => {
    const sessionDirectory = await createTempDir('actoviq-permissions-');
    let executed = false;
    const modelApi = new MockModelApi({
      create: async (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Attempting write.' },
              { type: 'tool_use', id: 'toolu_write', name: 'write_note', input: { text: 'secret' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Write blocked by permissions.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      permissionMode: 'bypassPermissions',
      permissions: [{ toolName: 'write_note', behavior: 'deny' }],
    });

    const writeNote = tool(
      {
        name: 'write_note',
        description: 'Writes a note somewhere.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => {
        executed = true;
        return { ok: true, text };
      },
    );

    try {
      const result = await sdk.run('Please write a note.', { tools: [writeNote] });
      expect(executed).toBe(false);
      expect(result.permissionDecisions).toHaveLength(1);
      expect(result.permissionDecisions?.[0]).toMatchObject({
        behavior: 'deny',
        source: 'rule',
      });
      expect(result.toolCalls[0]?.isError).toBe(true);
      expect(result.toolCalls[0]?.outputText).toContain('Denied by permission rule');
    } finally {
      await sdk.close();
    }
  });

  it('allows classifier-approved tool execution in restrictive mode', async () => {
    const sessionDirectory = await createTempDir('actoviq-classifier-');
    let executed = false;
    const modelApi = new MockModelApi({
      create: async (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Need to write.' },
              { type: 'tool_use', id: 'toolu_write', name: 'write_note', input: { text: 'approved' } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Write approved.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      permissionMode: 'plan',
      classifier: ({ publicName }) =>
        publicName === 'write_note'
          ? { behavior: 'allow', reason: 'Classifier approved the tool call.' }
          : undefined,
    });

    const writeNote = tool(
      {
        name: 'write_note',
        description: 'Writes a note somewhere.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => {
        executed = true;
        return { ok: true, text };
      },
    );

    try {
      const result = await sdk.run('Please write a note.', { tools: [writeNote] });
      expect(executed).toBe(true);
      expect(result.permissionDecisions?.[0]).toMatchObject({
        behavior: 'allow',
        source: 'classifier',
      });
      expect(result.toolCalls[0]?.isError).toBe(false);
    } finally {
      await sdk.close();
    }
  });

  it('adds api microcompact context management for tool-heavy follow-up requests', async () => {
    const sessionDirectory = await createTempDir('actoviq-microcompact-');
    const modelApi = new MockModelApi({
      create: async (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'I will use a tool.' },
              { type: 'tool_use', id: 'toolu_1', name: 'lookup_number', input: { value: 5 } },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Done.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    const lookupNumber = tool(
      {
        name: 'lookup_number',
        description: 'Returns the number provided.',
        inputSchema: z.object({ value: z.number() }),
      },
      async ({ value }) => ({ value }),
    );

    try {
      await sdk.run('Use the tool.', { tools: [lookupNumber] });
      expect(modelApi.createCalls).toHaveLength(2);
      expect(modelApi.createCalls[1]?.context_management).toMatchObject({
        edits: expect.any(Array),
      });
      expect(
        ((modelApi.createCalls[1]?.context_management as { edits?: Array<{ type: string }> })?.edits ?? []).some(
          edit => edit.type === 'clear_tool_uses_20250919',
        ),
      ).toBe(true);
    } finally {
      await sdk.close();
    }
  });

  it('supports swarm teammates, side sessions, and background completion mail', async () => {
    const sessionDirectory = await createTempDir('actoviq-swarm-');
    const seenPrompts: string[] = [];
    const modelApi = new MockModelApi({
      create: async (request) => {
        const lastUserMessage = request.messages.at(-1);
        const prompt =
          typeof lastUserMessage?.content === 'string'
            ? lastUserMessage.content
            : JSON.stringify(lastUserMessage?.content ?? '');
        seenPrompts.push(prompt);
        if (prompt.includes('Background follow-up')) {
          await delay(150);
        }
        return makeMessage([{ type: 'text', text: `Handled: ${prompt}` }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Reviews release work.',
          systemPrompt: 'Be concise and review-oriented.',
        },
      ],
    });

    try {
      const team = sdk.swarm.createTeam({ name: 'release-team', leader: 'lead' });
      const spawned = await team.spawn({
        name: 'reviewer-1',
        agent: 'reviewer',
        prompt: 'Initial review',
      });
      await team.message('reviewer-1', 'Leader note: focus on release blockers.');
      const backgroundTask = await team.runBackground('reviewer-1', 'Background follow-up');
      const teammates = await team.waitForIdle();
      const inbox = await team.inbox();
      const teammateSession = await team.session('reviewer-1');
      const backgroundRecord = await sdk.tasks.get(backgroundTask.id);

      expect(spawned.result?.text).toContain('Initial review');
      expect(teammates[0]?.status).toBe('idle');
      expect(teammates[0]?.lastTaskStatus).toBe('completed');
      expect(teammates[0]?.backgroundRunCount).toBe(1);
      expect(backgroundRecord?.status).toBe('completed');
      expect(inbox.some(message => message.text.includes('Background follow-up'))).toBe(true);
      expect(seenPrompts.some(prompt => prompt.includes('<teammate-message teammate_id="lead">'))).toBe(true);
      expect(teammateSession.messages.length).toBeGreaterThan(0);
    } finally {
      await sdk.close();
    }
  });

  it('supports mailbox-driven teammate continuation and teammate recovery', async () => {
    const sessionDirectory = await createTempDir('actoviq-swarm-continuity-');
    const seenPrompts: string[] = [];
    let hasFailedOnce = false;
    const modelApi = new MockModelApi({
      create: async (request) => {
        const lastUserMessage = request.messages.at(-1);
        const prompt =
          typeof lastUserMessage?.content === 'string'
            ? lastUserMessage.content
            : JSON.stringify(lastUserMessage?.content ?? '');
        seenPrompts.push(prompt);
        if (prompt.includes('Force a failure') && !hasFailedOnce) {
          hasFailedOnce = true;
          throw new Error('Simulated teammate failure');
        }
        return makeMessage([{ type: 'text', text: `Handled: ${prompt}` }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Reviews release work.',
          systemPrompt: 'Be concise and review-oriented.',
        },
      ],
    });

    try {
      const team = sdk.swarm.createTeam({ name: 'continuity-team', leader: 'lead' });
      await team.spawn({
        name: 'reviewer-1',
        agent: 'reviewer',
        prompt: 'Initial continuity review',
      });

      await team.message('reviewer-1', 'Leader note: continue from the mailbox.');
      const mailboxResult = await team.continueFromMailbox('reviewer-1');
      const afterMailbox = await team.teammate('reviewer-1').state();

      expect(mailboxResult?.source).toBe('mailbox');
      expect(mailboxResult?.mailboxMessagesProcessed).toBe(1);
      expect(afterMailbox?.status).toBe('idle');
      expect(afterMailbox?.runCount).toBe(2);
      expect(afterMailbox?.mailboxTurns).toBe(1);
      expect(afterMailbox?.mailboxMessageCount).toBe(1);
      expect(
        seenPrompts.some(
          prompt =>
            prompt.includes('<teammate-message teammate_id="lead">') &&
            prompt.includes('Leader note: continue from the mailbox.'),
        ),
      ).toBe(true);

      await expect(team.run('reviewer-1', 'Force a failure')).rejects.toThrow(
        'Simulated teammate failure',
      );
      const failed = await team.teammate('reviewer-1').state();
      expect(failed?.status).toBe('failed');
      expect(failed?.lastTaskStatus).toBe('failed');

      const recovered = await team.teammate('reviewer-1').recover();
      expect(recovered.status).toBe('idle');
      expect(recovered.recoveryCount).toBe(1);

      await team.message('reviewer-1', 'Leader note: resume after recovery.');
      const continued = await team.continueAllFromMailbox();
      const finalState = await team.teammate('reviewer-1').state();

      expect(continued).toHaveLength(1);
      expect(finalState?.status).toBe('idle');
      expect(finalState?.mailboxTurns).toBe(2);
      expect(finalState?.lineage).toEqual(
        expect.arrayContaining([expect.stringContaining('recovered')]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('can replace private computer-use tooling with public executor-backed tools', async () => {
    const sessionDirectory = await createTempDir('actoviq-computer-');
    const calls: string[] = [];
    const modelApi = new MockModelApi({
      create: async (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Opening the browser.' },
              {
                type: 'tool_use',
                id: 'toolu_open_url',
                name: 'computer_open_url',
                input: { url: 'https://example.com' },
              },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Browser opened.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      computerUse: {
        executor: {
          openUrl: async (url) => {
            calls.push(`open:${url}`);
          },
          typeText: async (text) => {
            calls.push(`type:${text}`);
          },
          keyPress: async (keys) => {
            calls.push(`keys:${keys.join('+')}`);
          },
          readClipboard: async () => 'clipboard',
          writeClipboard: async (text) => {
            calls.push(`clipboard:${text}`);
          },
          takeScreenshot: async (outputPath) => outputPath,
        },
      },
    });

    try {
      const result = await sdk.run('Open the browser.');
      expect(result.toolCalls[0]?.publicName).toBe('computer_open_url');
      expect(calls).toContain('open:https://example.com');
    } finally {
      await sdk.close();
    }
  });

  it('supports multi-step public computer-use workflows', async () => {
    const sessionDirectory = await createTempDir('actoviq-computer-workflow-');
    const calls: string[] = [];
    const modelApi = new MockModelApi({
      create: async (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Running a workflow.' },
              {
                type: 'tool_use',
                id: 'toolu_workflow',
                name: 'computer_run_workflow',
                input: {
                  steps: [
                    { action: 'open_url', url: 'https://example.com' },
                    { action: 'type_text', text: 'release-ready' },
                    { action: 'keypress', keys: ['ENTER'] },
                    { action: 'wait', durationMs: 1 },
                    { action: 'take_screenshot', outputPath: 'artifacts/release.png' },
                  ],
                },
              },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Workflow completed.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      computerUse: {
        executor: {
          openUrl: async (url) => {
            calls.push(`open:${url}`);
          },
          typeText: async (text) => {
            calls.push(`type:${text}`);
          },
          keyPress: async (keys) => {
            calls.push(`keys:${keys.join('+')}`);
          },
          readClipboard: async () => 'clipboard',
          writeClipboard: async (text) => {
            calls.push(`clipboard:${text}`);
          },
          takeScreenshot: async (outputPath) => {
            calls.push(`screenshot:${outputPath}`);
            return outputPath;
          },
        },
      },
    });

    try {
      const result = await sdk.run('Run the release UI workflow.');
      const workflowOutput = result.toolCalls[0]?.output as
        | { stepCount?: number; results?: Array<Record<string, unknown>> }
        | undefined;

      expect(result.toolCalls[0]?.publicName).toBe('computer_run_workflow');
      expect(workflowOutput?.stepCount).toBe(5);
      expect(calls).toEqual([
        'open:https://example.com',
        'type:release-ready',
        'keys:ENTER',
        'screenshot:artifacts/release.png',
      ]);
    } finally {
      await sdk.close();
    }
  });

  it('provides a composable computer-use toolkit with focus-aware workflow steps', async () => {
    const sessionDirectory = await createTempDir('actoviq-computer-toolkit-');
    const calls: string[] = [];
    const toolkit = createActoviqComputerUseToolkit({
      executor: {
        openUrl: async (url) => {
          calls.push(`open:${url}`);
        },
        focusWindow: async (title) => {
          calls.push(`focus:${title}`);
        },
        typeText: async (text) => {
          calls.push(`type:${text}`);
        },
        keyPress: async (keys) => {
          calls.push(`keys:${keys.join('+')}`);
        },
        readClipboard: async () => 'release clipboard text',
        writeClipboard: async (text) => {
          calls.push(`clipboard:${text}`);
        },
        takeScreenshot: async (outputPath) => {
          calls.push(`screenshot:${outputPath}`);
          return outputPath;
        },
      },
    });
    const modelApi = new MockModelApi({
      create: async (_request, index) => {
        if (index === 0) {
          return makeMessage(
            [
              { type: 'text', text: 'Running a richer browser workflow.' },
              {
                type: 'tool_use',
                id: 'toolu_workflow_focus',
                name: 'computer_run_workflow',
                input: {
                  steps: [
                    { action: 'open_url', url: 'https://example.com/releases' },
                    { action: 'focus_window', title: 'Example Domain' },
                    { action: 'write_clipboard', text: 'release checklist' },
                    { action: 'read_clipboard' },
                    { action: 'take_screenshot', outputPath: 'artifacts/focus.png' },
                  ],
                },
              },
            ],
            'tool_use',
          );
        }
        return makeMessage([{ type: 'text', text: 'Toolkit workflow completed.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      tools: toolkit.tools,
      mcpServers: [toolkit.mcpServer],
    });

    try {
      const result = await sdk.run('Run the focus-aware release workflow.');
      const workflowOutput = result.toolCalls[0]?.output as
        | { stepCount?: number; results?: Array<Record<string, unknown>> }
        | undefined;

      expect(toolkit.mcpServer.name).toBe('actoviq-computer-use');
      expect(result.toolCalls[0]?.publicName).toBe('computer_run_workflow');
      expect(workflowOutput?.stepCount).toBe(5);
      expect(calls).toEqual([
        'open:https://example.com/releases',
        'focus:Example Domain',
        'clipboard:release checklist',
        'screenshot:artifacts/focus.png',
      ]);
    } finally {
      await sdk.close();
    }
  });
});
