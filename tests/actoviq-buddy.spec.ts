import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  createActoviqBuddyApi,
  createAgentSdk,
  loadJsonConfigFile,
  rollActoviqBuddy,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  clearLoadedJsonConfig();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(text: string): Message {
  return {
    id: 'msg_buddy_fixture',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
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

function createNoopStream(): ModelStreamHandle {
  return {
    async finalMessage() {
      return makeMessage('stream-not-used');
    },
    async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
      return;
    },
  };
}

describe('Actoviq buddy API', () => {
  it('hatches a buddy, persists it, and exposes prompt context helpers', async () => {
    const tempDir = await createTempDir('actoviq-buddy-api-');
    const configPath = path.join(tempDir, 'settings.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          userID: 'buddy-user',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await loadJsonConfigFile(configPath);
    const buddyApi = createActoviqBuddyApi();

    const hatched = await buddyApi.hatch({
      name: 'Nova',
      personality: 'playful and precise',
    });
    const promptContext = await buddyApi.getPromptContext();
    const skippedPrompt = await buddyApi.getPromptContext({ announcedNames: ['Nova'] });
    const mutedState = await buddyApi.mute();
    const petWhileMuted = await buddyApi.pet();
    const unmutedState = await buddyApi.unmute();
    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;

    expect(hatched.name).toBe('Nova');
    expect(hatched.species).toBe(rollActoviqBuddy('buddy-user').bones.species);
    expect(promptContext).toMatchObject({
      buddy: expect.objectContaining({ name: 'Nova' }),
      attachment: expect.objectContaining({
        type: 'companion_intro',
        name: 'Nova',
      }),
    });
    expect(promptContext?.text).toContain('A small');
    expect(promptContext?.text).toContain('Nova');
    expect(skippedPrompt).toBeUndefined();
    expect(mutedState.muted).toBe(true);
    expect(petWhileMuted).toBeUndefined();
    expect(unmutedState.muted).toBe(false);
    expect(persisted.companion).toMatchObject({
      name: 'Nova',
      personality: 'playful and precise',
    });
    expect(persisted.companionMuted).toBe(false);
  });

  it('is exposed on the standard SDK and augments the system prompt automatically', async () => {
    const tempDir = await createTempDir('actoviq-buddy-agent-');
    const configPath = path.join(tempDir, 'settings.json');
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          ACTOVIQ_AUTH_TOKEN: 'fixture-token',
          userID: 'agent-buddy-user',
          companion: {
            name: 'Orbit',
            personality: 'steady and observant',
            hatchedAt: 123,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await loadJsonConfigFile(configPath);

    const seenRequests: ModelRequest[] = [];
    const modelApi: ModelApi = {
      async createMessage(request) {
        seenRequests.push(structuredClone(request));
        return makeMessage('hello from the model');
      },
      streamMessage() {
        return createNoopStream();
      },
    };

    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory: tempDir,
      modelApi,
    });

    try {
      await sdk.run('say hi');
      const buddy = await sdk.buddy.get();

      expect(buddy).toMatchObject({
        name: 'Orbit',
        personality: 'steady and observant',
      });
      expect(seenRequests[0]?.system).toContain('# Companion');
      expect(seenRequests[0]?.system).toContain('Orbit');
      expect(seenRequests[0]?.system).toContain('separate watcher');
    } finally {
      await sdk.close();
    }
  });

});
