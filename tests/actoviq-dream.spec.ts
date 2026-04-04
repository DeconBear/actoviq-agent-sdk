import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentSdk,
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

async function createSandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-dream-'));
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'project');
  const sessionDirectory = path.join(root, 'session-store');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  tempDirs.push(root);
  return {
    homeDir,
    workDir,
    sessionDirectory,
  };
}

function makeMessage(content: unknown[], stopReason: 'end_turn' | 'tool_use' = 'end_turn'): Message {
  messageCounter += 1;
  return {
    id: `msg_dream_${messageCounter}`,
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
      output_tokens: 10,
    },
  } as Message;
}

class StaticStream implements ModelStreamHandle {
  constructor(private readonly message: Message) {}

  async finalMessage(): Promise<Message> {
    return this.message;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    return;
  }
}

class DreamModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];

  constructor(private readonly handler: (request: ModelRequest, index: number) => Message) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    return this.handler(request, this.createCalls.length - 1);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    return new StaticStream(makeMessage([{ type: 'text', text: `unexpected stream ${request.model}` }]));
  }
}

describe('Actoviq dream parity', () => {
  it('runs a manual dream pass through the clean session API and updates durable memory files', async () => {
    const sandbox = await createSandbox();
    let autoMemoryDir = '';
    const modelApi = new DreamModelApi((_request, index) => {
      const notePath = path.join(autoMemoryDir, 'project-memory.md');
      if (index === 0) {
        return makeMessage(
          [
            { type: 'text', text: 'I will consolidate memory now.' },
            {
              type: 'tool_use',
              id: 'toolu_dream_write',
              name: 'Write',
              input: {
                file_path: notePath,
                content: [
                  '---',
                  'name: project-memory',
                  'description: Stable project facts',
                  'type: note',
                  '---',
                  '',
                  'The project uses the clean Actoviq SDK path.',
                ].join('\n'),
              },
            },
          ],
          'tool_use',
        );
      }
      return makeMessage([{ type: 'text', text: `Consolidated memory into ${notePath}.` }]);
    });

    const sdk = await createAgentSdk({
      homeDir: sandbox.homeDir,
      workDir: sandbox.workDir,
      sessionDirectory: sandbox.sessionDirectory,
      model: 'test-model',
      modelApi,
    });

    try {
      autoMemoryDir = (await sdk.memory.paths({ projectPath: sandbox.workDir })).autoMemoryDir;
      const session = await sdk.createSession({ title: 'Dream Session' });
      const result = await session.dream({
        extraContext: 'Capture the stable project choice about using the clean SDK path.',
      });
      const storedPath = path.join(autoMemoryDir, 'project-memory.md');
      const stored = await readFile(storedPath, 'utf8');

      expect(result.skipped).toBe(false);
      expect(result.result?.toolCalls).toHaveLength(1);
      expect(result.touchedFiles).toContain(storedPath);
      expect(stored).toContain('clean Actoviq SDK path');
      expect(await session.dreamState()).toMatchObject({
        currentSessionId: session.id,
      });
    } finally {
      await sdk.close();
    }
  });

  it('launches auto dream as a background task when the clean gate is satisfied', async () => {
    const sandbox = await createSandbox();
    let autoMemoryDir = '';
    const modelApi = new DreamModelApi((_request, index) => {
      if (index === 0) {
        return makeMessage(
          [
            {
              type: 'tool_use',
              id: 'toolu_auto_dream_write',
              name: 'Write',
              input: {
                file_path: path.join(autoMemoryDir, 'auto-dream.md'),
                content: [
                  '---',
                  'name: auto-dream',
                  'description: Auto-dream notes',
                  'type: note',
                  '---',
                  '',
                  'Auto dream reviewed recent sessions.',
                ].join('\n'),
              },
            },
          ],
          'tool_use',
        );
      }
      return makeMessage([{ type: 'text', text: 'Auto dream finished.' }]);
    });

    const sdk = await createAgentSdk({
      homeDir: sandbox.homeDir,
      workDir: sandbox.workDir,
      sessionDirectory: sandbox.sessionDirectory,
      model: 'test-model',
      modelApi,
    });

    try {
      autoMemoryDir = (await sdk.memory.paths({ projectPath: sandbox.workDir })).autoMemoryDir;
      await sdk.memory.updateSettings({ autoDreamEnabled: true }, { homeDir: sandbox.homeDir });
      const current = await sdk.createSession({ title: 'Current session' });
      for (let index = 0; index < 5; index += 1) {
        await sdk.createSession({ title: `Older session ${index + 1}` });
      }

      const launched = await sdk.maybeAutoDream({
        currentSessionId: current.id,
        background: true,
      });

      expect(launched.skipped).toBe(false);
      expect(launched.task?.subagentType).toBe('dream');
      expect(launched.touchedSessions).toHaveLength(5);

      const completed = await sdk.tasks.wait(launched.task!.id, { timeoutMs: 5_000 });
      expect(completed.status).toBe('completed');
      expect(completed.text).toContain('Auto dream finished');
    } finally {
      await sdk.close();
    }
  });

  it('does not auto-launch dream from teammate or background side sessions', async () => {
    const sandbox = await createSandbox();
    const modelApi = new DreamModelApi((_request) =>
      makeMessage([{ type: 'text', text: 'Handled teammate turn.' }]),
    );

    const sdk = await createAgentSdk({
      homeDir: sandbox.homeDir,
      workDir: sandbox.workDir,
      sessionDirectory: sandbox.sessionDirectory,
      model: 'test-model',
      modelApi,
    });

    try {
      await sdk.memory.updateSettings({ autoDreamEnabled: true }, { homeDir: sandbox.homeDir });
      for (let index = 0; index < 5; index += 1) {
        await sdk.createSession({ title: `Top-level session ${index + 1}` });
      }

      const teammateSession = await sdk.createSession({
        title: 'Teammate session',
        metadata: {
          __actoviqSwarmTeam: 'release-team',
          __actoviqTeammateName: 'reviewer-1',
        },
      });

      await teammateSession.send('Continue the teammate work.');

      const tasks = await sdk.tasks.list();
      expect(tasks.filter(task => task.subagentType === 'dream')).toHaveLength(0);
    } finally {
      await sdk.close();
    }
  });

  it('skips auto dream cleanly when the session threshold is not met', async () => {
    const sandbox = await createSandbox();
    const modelApi = new DreamModelApi(() => makeMessage([{ type: 'text', text: 'unused' }]));

    const sdk = await createAgentSdk({
      homeDir: sandbox.homeDir,
      workDir: sandbox.workDir,
      sessionDirectory: sandbox.sessionDirectory,
      model: 'test-model',
      modelApi,
    });

    try {
      await sdk.memory.updateSettings({ autoDreamEnabled: true }, { homeDir: sandbox.homeDir });
      const current = await sdk.createSession({ title: 'Current session' });
      await sdk.createSession({ title: 'Only one old session' });

      const result = await sdk.maybeAutoDream({
        currentSessionId: current.id,
        background: false,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('session_gate');
      expect(result.touchedSessions).toHaveLength(1);
    } finally {
      await sdk.close();
    }
  });
});
