import { describe, expect, it, vi } from 'vitest';

import { createCheckpointTools } from '../src/checkpoint/checkpointTools.js';

describe('checkpoint tools', () => {
  it('keeps restore interactive and requires an explicit confirmation literal', async () => {
    const service = {
      list: vi.fn(async () => []),
      preview: vi.fn(async () => ({ files: [], conflicts: [] })),
      restore: vi.fn(async () => ({
        checkpointId: 'cp',
        mode: 'files',
        restoredFiles: [],
        conversationRestored: false,
        conflicts: [],
      })),
    };
    const tools = createCheckpointTools({
      service: service as never,
      sessionId: 'session',
    });
    const restore = tools.find(tool => tool.name === 'RestoreCheckpoint')!;

    expect(restore.requiresUserInteraction?.()).toBe(true);
    await expect(restore.inputSchema.parseAsync({
      checkpointId: 'cp',
      mode: 'files',
      confirm: false,
    })).rejects.toThrow();
    await restore.execute({
      checkpointId: 'cp',
      mode: 'files',
      confirm: true,
      force: false,
    }, {} as never);
    expect(service.restore).toHaveBeenCalledWith({
      sessionId: 'session',
      checkpointId: 'cp',
      mode: 'files',
      force: false,
    });
  });
});
