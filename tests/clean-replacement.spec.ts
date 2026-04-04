import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ACTOVIQ_COMPUTER_USE_WORKFLOW_ACTIONS,
  createActoviqBridgeSdk,
  createActoviqComputerUseToolkit,
  createActoviqFileTools,
  createAgentSdk,
  localMcpServer,
  skill,
  tool,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
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
      create?: (request: ModelRequest, index: number) => Message;
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

describe('clean SDK replacement parity', () => {
  it('exposes clean tool discovery, context helpers, and slash-style replacements', async () => {
    const sessionDirectory = await createTempDir('actoviq-clean-tools-');
    const workDir = await createTempDir('actoviq-clean-tools-workdir-');
    const toolkit = createActoviqComputerUseToolkit({
      executor: {
        async openUrl() {},
        async focusWindow() {},
        async typeText() {},
        async keyPress() {},
        async readClipboard() {
          return 'clipboard';
        },
        async writeClipboard() {},
        async takeScreenshot(outputPath) {
          return outputPath;
        },
      },
    });
    const modelApi = new MockModelApi({
      create: (request) => {
        const internalTask =
          (request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task;
        if (internalTask === 'compact') {
          return makeMessage([{ type: 'text', text: 'Compact summary for clean command helpers.' }]);
        }
        return makeMessage([{ type: 'text', text: 'Normal response.' }]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      workDir,
      modelApi,
      tools: [...createActoviqFileTools({ cwd: workDir }), ...toolkit.tools],
      mcpServers: [
        toolkit.mcpServer,
        localMcpServer({
          kind: 'local',
          name: 'catalog',
          tools: [
            tool(
              {
                name: 'read_project_outline',
                description: 'Read the current project outline.',
                inputSchema: z.object({}),
              },
              async () => ({ ok: true }),
            ),
          ],
        }),
      ],
      agents: [
        {
          name: 'reviewer',
          description: 'Review changes with a release focus.',
        },
      ],
      skills: [
        skill({
          name: 'release-check',
          description: 'Review release readiness.',
          prompt: 'You are executing the /release-check skill.\n\nTask:\n$ARGUMENTS',
        }),
      ],
    });

    try {
      const toolMetadata = await sdk.tools.listMetadata();
      const toolCatalog = await sdk.tools.getCatalog();
      const session = await sdk.createSession({ title: 'Clean helper demo' });
      await session.send('Prepare a short release note.');
      const overview = await sdk.context.overview({
        sessionId: session.id,
        includeCompactState: true,
      });
      const contextText = await sdk.context.describe({
        sessionId: session.id,
        includeCompactState: true,
      });
      const slashCommands = sdk.slashCommands.listMetadata();
      const toolCommand = await sdk.slashCommands.run('tools');
      const memoryCommand = await sdk.slashCommands.run('memory', {
        sessionId: session.id,
      });
      const compactCommand = await sdk.slashCommands.run('compact', {
        sessionId: session.id,
        compact: {
          force: true,
          preserveRecentMessages: 1,
        },
      });

      expect(toolMetadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Read', category: 'file' }),
          expect.objectContaining({ name: 'Task', category: 'task' }),
          expect.objectContaining({ name: 'computer_open_url', category: 'computer' }),
          expect.objectContaining({ name: 'computer_focus_window', category: 'computer' }),
          expect.objectContaining({ name: 'computer_wait', category: 'computer' }),
          expect.objectContaining({ provider: 'mcp', category: 'mcp' }),
        ]),
      );
      expect(toolCatalog.byCategory.file.length).toBeGreaterThan(0);
      expect(toolCatalog.byCategory.computer.length).toBeGreaterThan(0);
      expect(toolCatalog.byCategory.task.length).toBe(1);
      expect(overview.tools.length).toBe(toolMetadata.length);
      expect(overview.skills).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'release-check' })]),
      );
      expect(overview.agents).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'reviewer' })]),
      );
      expect(contextText).toContain('# Clean Context Overview');
      expect(slashCommands.map(command => command.name)).toEqual([
        'context',
        'compact',
        'memory',
        'dream',
        'tools',
        'skills',
        'agents',
      ]);
      expect(toolCommand.text).toContain('# Tools');
      expect(memoryCommand.text).toContain('# Memory State');
      expect(compactCommand.text).toContain('# Compact Result');
    } finally {
      await sdk.close();
    }
  });

  it('inherits swarm runtime hooks and approvals, and exposes transcript plus reentry helpers', async () => {
    const sessionDirectory = await createTempDir('actoviq-clean-swarm-');
    const observedPrompts: string[] = [];
    let executedWrites = 0;
    const writeNote = tool(
      {
        name: 'write_note',
        description: 'Write a delegated release note.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => {
        executedWrites += 1;
        return { ok: true, text };
      },
    );
    const modelApi = new MockModelApi({
      create: (request) => {
        const lastMessage = request.messages.at(-1);
        const prompt =
          typeof lastMessage?.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage?.content ?? '');
        observedPrompts.push(prompt);

        const hookInjected = request.messages.some(
          message =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('Swarm runtime hook context'),
        );

        if (prompt.includes('Write the first note')) {
          return makeMessage(
            [
              {
                type: 'text',
                text: hookInjected ? 'Hooked reviewer is writing.' : 'Missing swarm hook.',
              },
              {
                type: 'tool_use',
                id: 'toolu_swarm_write',
                name: 'write_note',
                input: { text: 'swarm note' },
              },
            ],
            'tool_use',
          );
        }

        return makeMessage([
          {
            type: 'text',
            text: prompt.includes('Continue')
              ? 'Mailbox continuation finished.'
              : 'Reviewer finished the delegated note.',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Review changes and write notes when allowed.',
          tools: [writeNote],
        },
      ],
    });

    try {
      const team = sdk.swarm.createTeam({ name: 'release-team', leader: 'lead' });
      team.setRuntimeContext({
        hooks: {
          sessionStart: [
            () => ({
              messages: [
                {
                  role: 'user',
                  content:
                    '<system-reminder>Swarm runtime hook context: keep release notes concise.</system-reminder>',
                },
              ],
            }),
          ],
        },
        permissions: [{ toolName: 'write_note', behavior: 'ask' }],
        approver: ({ publicName }) =>
          publicName === 'write_note'
            ? { behavior: 'allow', reason: 'Swarm reviewer note approved.' }
            : { behavior: 'deny', reason: 'Unexpected tool.' },
      });

      const spawned = await team.spawn({
        name: 'reviewer-1',
        agent: 'reviewer',
        prompt: 'Write the first note.',
      });
      await team.message('reviewer-1', 'Continue from the mailbox.');
      const reentered = await team.reenter('reviewer-1');
      const transcript = await team.transcript('reviewer-1');

      expect(spawned.result?.text).toContain('Reviewer finished');
      expect(executedWrites).toBe(1);
      expect(
        modelApi.createCalls.some(request =>
          request.messages.some(
            message =>
              message.role === 'user' &&
              typeof message.content === 'string' &&
              message.content.includes('Swarm runtime hook context'),
          ),
        ),
      ).toBe(true);
      expect(reentered?.source).toBe('mailbox');
      expect(reentered?.result?.text).toContain('Mailbox continuation');
      expect(transcript.sessionId).toBeTruthy();
      expect(transcript.messages.length).toBeGreaterThan(0);
      expect(transcript.leaderInbox.some(message => message.text.includes('Reviewer finished'))).toBe(true);
    } finally {
      await sdk.close();
    }
  });

  it('tracks clean parity coverage against the local reference runtime', async () => {
    const sessionDirectory = await createTempDir('actoviq-clean-parity-');
    const workDir = await createTempDir('actoviq-clean-parity-workdir-');
    const modelApi = new MockModelApi({
      create: (request) => {
        const internalTask =
          (request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task;
        if (internalTask === 'compact') {
          return makeMessage([{ type: 'text', text: 'Clean compact summary.' }]);
        }
        return makeMessage([{ type: 'text', text: 'Parity baseline response.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      workDir,
      modelApi,
      tools: createActoviqFileTools({ cwd: workDir }),
      agents: [
        {
          name: 'reviewer',
          description: 'Review changes with a release focus.',
        },
      ],
    });
    const bridge = await createActoviqBridgeSdk({
      executable: process.execPath,
      cliPath: path.resolve('tests', 'fixtures', 'fake-actoviq-runtime-cli.mjs'),
      workDir,
      maxTurns: 2,
    });

    try {
      const runtimeCatalog = await bridge.getRuntimeCatalog();
      const cleanToolMetadata = await sdk.tools.listMetadata();
      const cleanSlashCommands = sdk.slashCommands.listMetadata().map(command => command.name);
      const cleanSkills = sdk.skills.listMetadata().map(skillDefinition => skillDefinition.name);
      const cleanAgents = sdk.agents.list().map(agentDefinition => agentDefinition.name);

      const cleanSession = await sdk.createSession({ title: 'Parity session' });
      await cleanSession.send('Prepare the clean parity baseline.');
      const cleanCompact = await cleanSession.compact({
        force: true,
        preserveRecentMessages: 1,
      });
      const bridgeCompact = await bridge.context.compact('summarize current progress');

      expect(runtimeCatalog.tools.some(tool => tool.name === 'Read')).toBe(
        cleanToolMetadata.some(tool => tool.name === 'Read'),
      );
      expect(runtimeCatalog.tools.some(tool => tool.name === 'Task')).toBe(
        cleanToolMetadata.some(tool => tool.name === 'Task'),
      );
      expect(runtimeCatalog.skills.some(skillDefinition => skillDefinition.name === 'debug')).toBe(
        cleanSkills.includes('debug'),
      );
      expect(runtimeCatalog.agents.some(agentDefinition => agentDefinition.name === 'reviewer')).toBe(
        cleanAgents.includes('reviewer'),
      );
      expect(cleanSlashCommands).toEqual(expect.arrayContaining(['context', 'compact']));
      expect(cleanCompact.compacted).toBe(true);
      expect(bridgeCompact.text).toContain('compact:');
    } finally {
      await bridge.close();
      await sdk.close();
    }
  });

  it('expands the public computer-use toolkit with reusable workflow actions', async () => {
    const toolkit = createActoviqComputerUseToolkit({
      executor: {
        async openUrl() {},
        async focusWindow() {},
        async typeText() {},
        async keyPress() {},
        async readClipboard() {
          return 'clipboard';
        },
        async writeClipboard() {},
        async takeScreenshot(outputPath) {
          return outputPath;
        },
      },
    });

    expect(toolkit.tools.map(toolDefinition => toolDefinition.name)).toEqual(
      expect.arrayContaining(['computer_focus_window', 'computer_wait', 'computer_run_workflow']),
    );
    expect([...ACTOVIQ_COMPUTER_USE_WORKFLOW_ACTIONS]).toEqual(
      expect.arrayContaining(['focus_window', 'wait']),
    );
  });
});
