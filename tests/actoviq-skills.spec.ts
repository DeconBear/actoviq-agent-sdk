import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSdk, type ModelApi, type ModelRequest, type ModelStreamHandle } from '../src/index.js';
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

describe('clean SDK skills', () => {
  it('lists bundled skills and executes an inline bundled skill', async () => {
    const sessionDirectory = await createTempDir('actoviq-skills-session-');
    const modelApi = new MockModelApi({
      create: request =>
        makeMessage([
          {
            type: 'text',
            text: typeof request.messages.at(-1)?.content === 'string'
              ? request.messages.at(-1)!.content
              : 'no skill prompt found',
          },
        ]),
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const skills = sdk.skills.listMetadata();
      const result = await sdk.runSkill('debug', 'Investigate the release order mismatch.');

      expect(skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'debug', source: 'bundled' }),
          expect.objectContaining({ name: 'simplify', source: 'bundled' }),
        ]),
      );
      expect(modelApi.createCalls[0]?.messages.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringContaining('You are executing the /debug skill.'),
      });
      expect(result.text).toContain('Investigate the release order mismatch.');
      expect(result.invokedSkills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'debug', context: 'inline', source: 'bundled' }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('loads project skills from disk and preserves skill continuity after compaction', async () => {
    const tempDir = await createTempDir('actoviq-skills-project-');
    const homeDir = path.join(tempDir, 'home');
    const workDir = path.join(tempDir, 'workspace');
    const sessionDirectory = path.join(tempDir, 'sessions');
    await mkdir(path.join(workDir, '.actoviq', 'skills', 'release-check'), { recursive: true });
    await writeFile(
      path.join(workDir, '.actoviq', 'skills', 'release-check', 'SKILL.md'),
      [
        '---',
        'description: Verify release ordering before tagging',
        'when_to_use: Use when you need to confirm tag and version sequencing',
        '---',
        '',
        'Verify the current release workflow before tagging.',
        '',
        'Workspace root: ${ACTOVIQ_SKILL_DIR}',
        'Task: $ARGUMENTS',
      ].join('\n'),
      'utf8',
    );

    const modelApi = new MockModelApi({
      create: request => {
        if ((request.metadata as Record<string, unknown> | undefined)?.actoviq_internal_task === 'compact') {
          return makeMessage([
            {
              type: 'text',
              text: 'Compact summary for the release-check skill path.',
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: typeof request.messages.at(-1)?.content === 'string'
              ? request.messages.at(-1)!.content
              : 'non-string input',
          },
        ]);
      },
    });

    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir,
      workDir,
      sessionDirectory,
      modelApi,
      disableDefaultSkills: true,
    });

    try {
      expect(sdk.skills.getMetadata('release-check')).toMatchObject({
        name: 'release-check',
        source: 'project',
        loadedFrom: 'skills',
      });

      const session = await sdk.createSession();
      await session.runSkill('release-check', 'Verify the release tag order.');
      await session.compact({ force: true, preserveRecentMessages: 1 });
      await session.send('Continue the release-check flow.');

      const compactState = await session.compactState({ includeBoundaries: true });
      const thirdRequest = modelApi.createCalls[2];
      const reminderMessages = thirdRequest?.messages.filter(
        message =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('release-check'),
      );

      expect(compactState.invokedSkills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'release-check',
            source: 'project',
            loadedFrom: 'skills',
          }),
        ]),
      );
      expect(reminderMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining('The inline skill "/release-check" remains active'),
          }),
          expect.objectContaining({
            content: expect.stringContaining('Task: Verify the release tag order.'),
          }),
        ]),
      );
    } finally {
      await sdk.close();
    }
  });

  it('supports custom forked skills routed through named agents', async () => {
    const sessionDirectory = await createTempDir('actoviq-skills-fork-');
    const modelApi = new MockModelApi({
      create: request => {
        if (request.system?.includes('Review code carefully and focus on risks.')) {
          return makeMessage([
            {
              type: 'text',
              text: 'Reviewer skill execution completed.',
            },
          ]);
        }

        return makeMessage([
          {
            type: 'text',
            text: 'Unexpected non-review path.',
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
          description: 'Review changes and call out risks.',
          systemPrompt: 'Review code carefully and focus on risks.',
        },
      ],
      skills: [
        {
          name: 'review-release',
          description: 'Review a release plan in a forked reviewer lane.',
          context: 'fork',
          agent: 'reviewer',
          prompt: 'Review the release plan carefully.\n\nTask: $ARGUMENTS',
        },
      ],
      disableDefaultSkills: true,
    });

    try {
      const result = await sdk.runSkill('review-release', 'Check release ordering and rollback safety.');

      expect(result.text).toContain('Reviewer skill execution completed.');
      expect(result.invokedSkills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'review-release',
            context: 'fork',
            agent: 'reviewer',
          }),
        ]),
      );
      expect(modelApi.createCalls[0]?.system).toContain('Review code carefully and focus on risks.');
    } finally {
      await sdk.close();
    }
  });
});
