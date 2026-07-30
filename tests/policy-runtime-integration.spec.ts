import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAgentSdk, tool, type ModelApi } from '../src/index.js';
import type { Message } from '../src/provider/types.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('managed policy runtime integration', () => {
  it('applies project settings and deny rules before caller overrides', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-policy-runtime-'));
    dirs.push(dir);
    const workDir = path.join(dir, 'workspace');
    await mkdir(path.join(workDir, '.actoviq'), { recursive: true });
    await writeFile(
      path.join(workDir, '.actoviq', 'policy.json'),
      JSON.stringify({
        version: 1,
        revision: 1,
        scope: 'project',
        settings: {
          model: 'policy-model',
          effort: 'high',
          permissionMode: 'bypassPermissions',
          sandbox: {
            network: { mode: 'deny' },
          },
        },
        rules: [{
          id: 'deny-echo',
          effect: 'deny',
          tool: 'Echo',
          reason: 'Managed policy blocks Echo.',
        }],
        lockedSettings: ['model', 'sandbox'],
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const execute = vi.fn(async () => 'executed');
    let call = 0;
    const modelApi = {
      createMessage: async () => {
        call += 1;
        return {
          id: `message-${call}`,
          type: 'message',
          role: 'assistant',
          model: 'test',
          content: call === 1
            ? [{ type: 'tool_use', id: 'tool-1', name: 'Echo', input: {} }]
            : [{ type: 'text', text: 'done' }],
          stop_reason: call === 1 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as Message;
      },
      streamMessage: () => { throw new Error('Unexpected stream.'); },
    } as unknown as ModelApi;

    const sdk = await createAgentSdk({
      homeDir: path.join(dir, 'home'),
      workDir,
      sessionDirectory: path.join(dir, 'sessions'),
      model: 'caller-model',
      effort: 'low',
      modelApi,
      tools: [tool({
        name: 'Echo',
        description: 'test',
        inputSchema: z.strictObject({}),
      }, execute)],
      permissionMode: 'bypassPermissions',
    });
    try {
      expect(sdk.config.model).toBe('policy-model');
      expect(sdk.config.effort).toBe('high');
      expect(sdk.config.sandbox.network.mode).toBe('deny');
      expect(sdk.config.effectivePolicy.sources).toEqual(['project']);
      expect(sdk.config.effectivePolicy.lockedSettings).toEqual(['model', 'sandbox']);
      const session = await sdk.createSession();
      await expect(session.setModel('other-model')).rejects.toThrow('locked');

      const result = await sdk.run('call Echo');
      expect(result.toolCalls[0]?.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await sdk.close();
    }
  });
});
