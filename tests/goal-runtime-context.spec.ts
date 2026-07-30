import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentSdk,
  GOAL_METADATA_KEY,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createSessionDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-goal-ctx-'));
  tempDirs.push(dir);
  return dir;
}

let messageCounter = 0;
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
    usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, input_tokens: 10, output_tokens: 5 },
  } as Message;
}

class MockStream implements ModelStreamHandle {
  constructor(private readonly message: Message) {}
  async finalMessage(): Promise<Message> { return this.message; }
  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> { /* no events */ }
}

class MockModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];
  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    return makeMessage([{ type: 'text', text: 'done' }]);
  }
  streamMessage(request: ModelRequest): ModelStreamHandle {
    this.createCalls.push(structuredClone(request));
    return new MockStream(makeMessage([{ type: 'text', text: 'done' }]));
  }
}

describe('goal runtime context injection', () => {
  it('injects the goal prompt and goal tools when an active goal exists', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi();
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });
    try {
      const session = await sdk.createSession({ title: 'goal ctx' });
      // Seed a goal via the legacy metadata shape (the service normalizes it).
      await session.mergeMetadata({
        [GOAL_METADATA_KEY]: {
          objective: 'ship the checkpoint feature',
          status: 'active',
          setAt: '2026-07-29T00:00:00Z',
        },
      });
      await session.send('what should I do?');

      const request = modelApi.createCalls[0]!;
      expect(request.system).toContain('Active goal');
      expect(request.system).toContain('ship the checkpoint feature');
      expect(request.tools?.some(t => t.name === 'GetGoal')).toBe(true);
      expect(request.tools?.some(t => t.name === 'CreateGoal')).toBe(true);
      expect(request.tools?.some(t => t.name === 'UpdateGoal')).toBe(true);
      const persisted = session.metadata[GOAL_METADATA_KEY] as {
        evidence: Array<{ note: string; toolCalls?: number; tokens?: number }>;
      };
      expect(persisted.evidence.at(-1)).toMatchObject({
        note: 'done',
        toolCalls: 0,
        tokens: 15,
      });
    } finally {
      await sdk.close();
    }
  });

  it('does not inject goal context when no goal is set', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi();
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });
    try {
      const session = await sdk.createSession({ title: 'no goal' });
      await session.send('hello');

      const request = modelApi.createCalls[0]!;
      expect(request.system).not.toContain('Active goal');
      expect(request.tools?.some(t => t.name === 'GetGoal')).toBe(true);
      expect(request.tools?.some(t => t.name === 'CreateGoal')).toBe(true);
    } finally {
      await sdk.close();
    }
  });

  it('does not inject goal context for a complete goal', async () => {
    const sessionDirectory = await createSessionDirectory();
    const modelApi = new MockModelApi();
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });
    try {
      const session = await sdk.createSession({ title: 'done goal' });
      await session.mergeMetadata({
        [GOAL_METADATA_KEY]: {
          version: 1,
          objective: 'finished',
          status: 'complete',
          evidence: [],
          blockAudit: [],
          createdAt: '2026-07-29T00:00:00Z',
          updatedAt: '2026-07-29T00:00:00Z',
          revision: 1,
        },
      });
      await session.send('anything else?');

      const request = modelApi.createCalls[0]!;
      expect(request.system).not.toContain('Active goal');
      // A complete goal does not steer further work, but the tools remain
      // available so the model can inspect or replace it after a new request.
      expect(request.tools?.some(t => t.name === 'GetGoal')).toBe(true);
      expect(request.tools?.some(t => t.name === 'CreateGoal')).toBe(true);
    } finally {
      await sdk.close();
    }
  });
});
