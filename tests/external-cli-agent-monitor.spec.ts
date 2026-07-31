import { describe, expect, it } from 'vitest';

import type { ExternalCliRunSnapshot } from '../src/parity/externalCliRuntimeManager.js';
import { createExternalCliAgentExecutionSnapshots } from '../src/gui/externalCliAgentMonitor.js';
import { createAgentExecutionProjectView } from '../src/ui/agentExecutionView.js';

function run(
  runId: string,
  status: ExternalCliRunSnapshot['status'],
  patch: Partial<ExternalCliRunSnapshot> = {},
): ExternalCliRunSnapshot {
  return {
    runId,
    hadamardSessionId: 'hadamard-session-1',
    configId: 'claude-native-config',
    cwd: 'C:/workspace/cand4',
    background: true,
    status,
    createdAt: '2026-07-19T08:00:00.000Z',
    startedAt: status === 'queued' ? undefined : '2026-07-19T08:00:01.000Z',
    finishedAt: status === 'running' || status === 'queued'
      ? undefined
      : '2026-07-19T08:00:05.000Z',
    nativeSessionId: 'claude-session-1',
    events: [],
    logs: [],
    ...patch,
  };
}

describe('External CLI Agent monitor adapter', () => {
  it('shows one reusable CLI agent per managed session and keeps the latest turn', () => {
    const snapshots = createExternalCliAgentExecutionSnapshots([
      {
        run: run('older', 'completed'),
        configName: 'Claude native',
        runtime: 'claude',
        model: 'claude-sonnet-4-5',
      },
      {
        run: run('latest', 'running', { createdAt: '2026-07-19T08:01:00.000Z' }),
        configName: 'Claude native',
        runtime: 'claude',
        model: 'claude-sonnet-4-5',
      },
    ], 'C:/workspace/cand4');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.nodes[0]).toMatchObject({
      sessionId: 'hadamard-session-1',
      runtime: 'claude',
      model: 'claude-sonnet-4-5',
      agentStatus: 'running',
      threadStatus: 'active',
      runIds: ['older', 'latest'],
    });
    expect(createAgentExecutionProjectView(snapshots).active).toHaveLength(1);
  });

  it('classifies a completed reusable CLI session as completed and excludes other projects', () => {
    const snapshots = createExternalCliAgentExecutionSnapshots([
      {
        run: run('completed', 'completed', {
          result: {
            text: 'Finished the requested change.',
            nativeSessionId: 'claude-session-1',
            isError: false,
            exitCode: 0,
            stderr: '',
          },
        }),
        configName: 'Claude native',
        runtime: 'claude',
        model: null,
      },
      {
        run: run('elsewhere', 'running', { cwd: 'C:/workspace/other' }),
        configName: 'Codex native',
        runtime: 'codex',
        model: null,
      },
    ], 'C:/workspace/cand4');
    const view = createAgentExecutionProjectView(snapshots);

    expect(view.active).toEqual([]);
    expect(view.waiting).toEqual([]);
    expect(view.completed).toHaveLength(1);
    expect(view.completed[0]?.root).toMatchObject({
      displayName: 'Claude native',
      status: 'completed',
      threadStatus: 'idle',
      currentActivity: { summary: 'Last run completed' },
      result: 'Finished the requested change.',
    });
  });

  it('keeps failed and aborted CLI runs in the terminal history', () => {
    const snapshots = createExternalCliAgentExecutionSnapshots([
      {
        run: run('failed', 'failed', {
          error: { name: 'Error', message: 'provider failed' },
        }),
        configName: 'Codex native',
        runtime: 'codex',
        model: null,
      },
      {
        run: run('aborted', 'aborted', {
          hadamardSessionId: 'hadamard-session-2',
          configId: 'pi-native-config',
        }),
        configName: 'Pi native',
        runtime: 'pi',
        model: null,
      },
    ], 'C:/workspace/cand4');
    const view = createAgentExecutionProjectView(snapshots);

    expect(view.waiting).toEqual([]);
    expect(view.completed.map(item => item.status)).toEqual(['shutdown', 'errored']);
  });
});
