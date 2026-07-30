import { describe, expect, it, vi } from 'vitest';

import { AppServer } from '../src/app-server/index.js';
import type { ActoviqAgentClient } from '../src/runtime/agentClient.js';

describe('AppServer approvals, diffs, and checkpoints', () => {
  it('requires explicit confirmation before mutating restore or diff operations', async () => {
    const restore = vi.fn(async () => ({ restoredFiles: ['file.ts'] }));
    const applySessionDiff = vi.fn(async () => ({ applied: true }));
    const sdk = {
      checkpoints: {
        list: vi.fn(async () => [{ id: 'checkpoint-1' }]),
        preview: vi.fn(async () => ({ files: [{ path: 'file.ts' }], conflicts: [] })),
        restore,
      },
      getSessionDiff: vi.fn(async () => ({ patch: 'diff --git a/file.ts b/file.ts' })),
      applySessionDiff,
      approvalPolicy: {
        list: vi.fn(async () => [{ id: 'approval-1', tool: 'Write', behavior: 'allow' }]),
        remember: vi.fn(async () => undefined),
      },
    } as unknown as ActoviqAgentClient;
    const server = new AppServer(sdk);

    expect((await server.handle(request('diff/apply', { sessionId: 'session-1' }))).error?.message)
      .toContain('confirm:true');
    expect((await server.handle(request('checkpoint/restore', {
      sessionId: 'session-1',
      checkpointId: 'checkpoint-1',
    }))).error?.message).toContain('confirm:true');
    expect(applySessionDiff).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();

    await server.handle(request('diff/apply', { sessionId: 'session-1', confirm: true }));
    await server.handle(request('checkpoint/restore', {
      sessionId: 'session-1',
      checkpointId: 'checkpoint-1',
      mode: 'files',
      confirm: true,
    }));
    expect(applySessionDiff).toHaveBeenCalledWith('session-1', undefined);
    expect(restore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      checkpointId: 'checkpoint-1',
      mode: 'files',
    });
  });

  it('lists and remembers durable approval decisions', async () => {
    const remember = vi.fn(async () => undefined);
    const sdk = {
      approvalPolicy: {
        list: vi.fn(async () => [{ id: 'approval-1', tool: 'Write', behavior: 'allow' }]),
        remember,
      },
    } as unknown as ActoviqAgentClient;
    const server = new AppServer(sdk);

    const listed = await server.handle(request('approval/list'));
    expect(listed.result).toEqual([{ id: 'approval-1', tool: 'Write', behavior: 'allow' }]);
    const approval = {
      id: 'approval-2',
      tool: 'Bash',
      behavior: 'deny',
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    expect((await server.handle(request('approval/remember', { approval }))).error?.message)
      .toContain('confirm:true');
    expect(remember).not.toHaveBeenCalled();

    await server.handle(request('approval/remember', { approval, confirm: true }));
    expect(remember).toHaveBeenCalledWith(approval);
  });

  it('rejects unbounded allow rules for mutating tools', async () => {
    const remember = vi.fn(async () => undefined);
    const sdk = {
      approvalPolicy: { list: vi.fn(async () => []), remember },
    } as unknown as ActoviqAgentClient;
    const server = new AppServer(sdk);
    const response = await server.handle(request('approval/remember', {
      confirm: true,
      approval: {
        id: 'open-bash',
        tool: 'Bash',
        behavior: 'allow',
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    }));
    expect(response.error?.message).toContain('pathPrefix');
    expect(remember).not.toHaveBeenCalled();
  });
});

function request(method: string, params: Record<string, unknown> = {}) {
  return { version: 1 as const, id: `request-${method}`, method, params };
}
