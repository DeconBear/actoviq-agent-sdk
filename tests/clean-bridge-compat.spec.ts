import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createActoviqCleanBridgeSdk,
  getActoviqCleanBridgeParityMatrix,
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

function makeMessage(text: string): Message {
  messageCounter += 1;
  return {
    id: `msg_clean_bridge_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  };
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

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    return makeMessage(`clean response ${this.createCalls.length}`);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    this.streamCalls.push(structuredClone(request));
    const text = `stream response ${this.streamCalls.length}`;
    return new MockStream(
      [
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
      ] as MessageStreamEvent[],
      makeMessage(text),
    );
  }
}

describe('clean bridge compatibility facade', () => {
  it('publishes a parity matrix for every bridge option', () => {
    const matrix = getActoviqCleanBridgeParityMatrix();
    const options = matrix.map(entry => entry.option);

    expect(options).toEqual(expect.arrayContaining([
      'model',
      'fallbackModel',
      'effort',
      'appendSystemPrompt',
      'permissionMode',
      'dangerouslySkipPermissions',
      'maxTurns',
      'maxBudgetUsd',
      'agent',
      'tools',
      'allowedTools',
      'disallowedTools',
      'mcpConfigs',
      'jsonSchema',
      'includePartialMessages',
      'includeHookEvents',
      'continueMostRecent',
      'forkSession',
      'signal',
    ]));
    expect(matrix.find(entry => entry.option === 'fallbackModel')?.status).toBe('unsupported');
    expect(matrix.find(entry => entry.option === 'tools')?.status).toBe('mapped');
  });

  it('maps bridge run options into clean run options and reports bridge-only fields', async () => {
    const sessionDirectory = await createTempDir('actoviq-clean-bridge-sessions-');
    const workDir = await createTempDir('actoviq-clean-bridge-workdir-');
    const modelApi = new MockModelApi();
    const echo = tool(
      {
        name: 'Echo',
        description: 'Echoes text.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({ text }),
    );
    const noisy = tool(
      {
        name: 'Noisy',
        description: 'Should be filtered out.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({ text }),
    );

    const sdk = await createActoviqCleanBridgeSdk({
      model: 'base-model',
      sessionDirectory,
      workDir,
      modelApi,
      tools: [echo, noisy],
      bridgeDefaults: {
        maxTurns: 4,
      },
    });

    try {
      const report = sdk.explainOptions({
        model: 'override-model',
        systemPrompt: 'Base prompt.',
        appendSystemPrompt: 'Append prompt.',
        permissionMode: 'dontAsk',
        tools: ['Echo'],
        allowedTools: ['Echo'],
        disallowedTools: ['Noisy'],
        fallbackModel: 'fallback-model',
        jsonSchema: { type: 'object' },
      });

      expect(report.mapped.map(entry => entry.option)).toEqual(expect.arrayContaining([
        'model',
        'systemPrompt',
        'appendSystemPrompt',
        'permissionMode',
        'tools',
        'allowedTools/disallowedTools',
      ]));
      expect(report.unsupported.map(entry => entry.option)).toEqual(expect.arrayContaining([
        'fallbackModel',
        'jsonSchema',
      ]));

      const result = await sdk.run('hello', {
        model: 'override-model',
        systemPrompt: 'Base prompt.',
        appendSystemPrompt: 'Append prompt.',
        tools: ['Echo'],
      });

      expect(result.text).toBe('clean response 1');
      expect(result.exitCode).toBe(0);
      expect(result.resultEvent?.type).toBe('result');
      expect(modelApi.createCalls[0]?.model).toBe('override-model');
      expect(modelApi.createCalls[0]?.system).toContain('Base prompt.\n\nAppend prompt.');
      expect(modelApi.createCalls[0]?.tools?.map(providerTool => providerTool.name)).toEqual(['Echo']);
    } finally {
      await sdk.close();
    }
  });

  it('adapts clean stream events to bridge stream-json events', async () => {
    const sessionDirectory = await createTempDir('actoviq-clean-bridge-stream-');
    const modelApi = new MockModelApi();
    const sdk = await createActoviqCleanBridgeSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const stream = sdk.stream('stream please', { includePartialMessages: true });
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }
      const result = await stream.result;

      expect(events.some(event => event.type === 'assistant' && event.subtype === 'text_delta')).toBe(true);
      expect(events.some(event => event.type === 'result')).toBe(true);
      expect(result.text).toBe('stream response 1');
      expect(result.assistantMessages.length).toBeGreaterThan(0);
    } finally {
      await sdk.close();
    }
  });

  it('supports bridge-style sessions, continuation, fork, catalog, and skills', async () => {
    const sessionDirectory = await createTempDir('actoviq-clean-bridge-session-');
    const workDir = await createTempDir('actoviq-clean-bridge-session-workdir-');
    const modelApi = new MockModelApi();
    const sdk = await createActoviqCleanBridgeSdk({
      model: 'test-model',
      sessionDirectory,
      workDir,
      modelApi,
      agents: [
        {
          name: 'reviewer',
          description: 'Reviews work.',
          systemPrompt: 'You are a reviewer.',
        },
      ],
      skills: [
        skill({
          name: 'audit',
          description: 'Audit a topic.',
          prompt: 'Audit: $ARGUMENTS',
          source: 'custom',
          loadedFrom: 'custom',
        }),
      ],
    });

    try {
      const session = await sdk.createSession({ sessionId: 'bridge-session-id', title: 'Bridge Session' });
      const first = await session.send('start session');
      expect(first.sessionId).toBe('bridge-session-id');

      const info = await session.info();
      expect(info?.id).toBe('bridge-session-id');
      const messages = await session.messages();
      expect(messages.some(message => message.type === 'assistant')).toBe(true);

      const continued = await sdk.continueMostRecent('continue');
      expect(continued.sessionId).toBe('bridge-session-id');

      const forked = await sdk.forkSession('bridge-session-id', 'fork this');
      expect(forked.sessionId).not.toBe('bridge-session-id');

      const skillResult = await sdk.skills.run('audit', 'permissions');
      expect(skillResult.text).toContain('clean response');

      const agentResult = await sdk.agents.run('reviewer', 'review this');
      expect(agentResult.text).toContain('clean response');

      const catalog = await sdk.getRuntimeCatalog();
      expect(catalog.agents.some(agent => agent.name === 'reviewer')).toBe(true);
      expect(catalog.skills.some(entry => entry.name === 'audit')).toBe(true);
      expect(catalog.slashCommands.some(command => command.name === 'audit' && command.kind === 'skill')).toBe(true);
    } finally {
      await sdk.close();
    }
  });
});
