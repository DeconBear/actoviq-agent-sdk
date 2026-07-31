import { mkdtemp, rm } from 'node:fs/promises';
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

describe('managed approval policy runtime', () => {
  it('applies remembered denies before a tool executes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-approval-runtime-'));
    dirs.push(dir);
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
      sessionDirectory: path.join(dir, 'sessions'),
      model: 'test',
      modelApi,
      tools: [tool({
        name: 'Echo',
        description: 'test',
        inputSchema: z.strictObject({}),
      }, execute)],
      permissionMode: 'default',
    });
    try {
      await sdk.approvalPolicy.remember({
        id: 'deny-echo',
        tool: 'Echo',
        behavior: 'deny',
        createdAt: new Date().toISOString(),
      });
      const result = await sdk.run('call Echo');
      expect(result.toolCalls[0]?.isError).toBe(true);
      expect(result.toolCalls[0]?.outputText).toContain('Remembered deny');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await sdk.close();
    }
  });
});
