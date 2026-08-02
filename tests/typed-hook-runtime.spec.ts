import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentSdk, type ModelApi } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('typed lifecycle hooks runtime', () => {
  it('blocks a turn before the model request when a blocking TurnStart hook fails', async () => {
    const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-typed-hooks-'));
    tempDirs.push(sessionDirectory);
    const createMessage = vi.fn();
    const modelApi = {
      createMessage,
      streamMessage: () => {
        throw new Error('Unexpected stream request.');
      },
    } as unknown as ModelApi;
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      typedHooks: [{
        id: 'turn-start-policy',
        event: 'TurnStart',
        errorPolicy: 'block',
        handler: {
          type: 'command',
          command: process.execPath,
          args: ['-e', 'process.exit(2)'],
        },
      }],
    });

    try {
      await expect(sdk.run('do not reach the model')).rejects.toThrow(
        'TurnStart hook "turn-start-policy" blocked',
      );
      expect(createMessage).not.toHaveBeenCalled();
    } finally {
      await sdk.close();
    }
  });

  it('runs SessionEnd once when the client closes', async () => {
    const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-session-end-hook-'));
    tempDirs.push(sessionDirectory);
    const marker = path.join(sessionDirectory, 'session-end.txt');
    const modelApi = {
      createMessage: async () => { throw new Error('Unexpected model call.'); },
      streamMessage: () => { throw new Error('Unexpected model call.'); },
    } as unknown as ModelApi;
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      typedHooks: [{
        id: 'session-end-marker',
        event: 'SessionEnd',
        handler: {
          type: 'command',
          command: process.execPath,
          args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'closed\\n')`],
        },
      }],
    });

    await sdk.close();
    await sdk.close();
    await expect(readFile(marker, 'utf8')).resolves.toBe('closed\n');
  });
});
