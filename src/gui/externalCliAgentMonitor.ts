import path from 'node:path';

import type {
  AgentExecutionActivity,
  AgentExecutionSnapshot,
  AgentExecutionStatus,
  AgentThreadStatus,
} from '../runtime/agentExecution.js';
import type { ExternalCliRunSnapshot } from '../parity/externalCliRuntimeManager.js';

export interface ExternalCliAgentMonitorRun {
  run: ExternalCliRunSnapshot;
  configName: string;
  runtime: string;
  model: string | null;
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function latestTimestamp(values: Array<string | undefined>, fallback: string): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? fallback;
}

function statusOf(status: ExternalCliRunSnapshot['status']): AgentExecutionStatus {
  switch (status) {
    case 'queued':
      return 'pending_init';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'errored';
    case 'aborted':
      return 'shutdown';
  }
}

function threadStatusOf(status: ExternalCliRunSnapshot['status']): AgentThreadStatus {
  if (status === 'queued' || status === 'running') return 'active';
  if (status === 'failed') return 'system_error';
  return 'idle';
}

function activityOf(item: ExternalCliAgentMonitorRun, at: string): AgentExecutionActivity {
  const runtime = item.runtime || 'External';
  switch (item.run.status) {
    case 'queued':
      return { kind: 'waiting', summary: `Queued for ${runtime} CLI`, startedAt: at };
    case 'running':
      return { kind: 'thinking', summary: `${runtime} CLI is working`, startedAt: at };
    case 'completed':
      return { kind: 'idle', summary: 'Last run completed', startedAt: at };
    case 'failed':
      return {
        kind: 'idle',
        summary: item.run.error?.message || `${runtime} CLI failed`,
        startedAt: at,
      };
    case 'aborted':
      return { kind: 'idle', summary: `${runtime} CLI was stopped`, startedAt: at };
  }
}

function groupKey(item: ExternalCliAgentMonitorRun): string {
  return [
    item.run.hadamardSessionId,
    item.run.configId,
    pathIdentity(item.run.cwd),
  ].join('\u0000');
}

/**
 * Converts managed CLI runs into the same persistent execution shape used by
 * Hadamard agents. Multiple turns for one cached native CLI session collapse
 * into one monitor entry, while every turn id remains available in `runIds`.
 */
export function createExternalCliAgentExecutionSnapshots(
  items: ExternalCliAgentMonitorRun[],
  projectPath: string,
): AgentExecutionSnapshot[] {
  const targetPath = pathIdentity(projectPath);
  const grouped = new Map<string, ExternalCliAgentMonitorRun[]>();
  for (const item of items) {
    if (pathIdentity(item.run.cwd) !== targetPath) continue;
    const key = groupKey(item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }

  return [...grouped.values()].map((group) => {
    const ordered = [...group].sort((left, right) =>
      left.run.createdAt.localeCompare(right.run.createdAt)
      || left.run.runId.localeCompare(right.run.runId)
    );
    const first = ordered[0]!;
    const latest = ordered.at(-1)!;
    const run = latest.run;
    const activityAt = latestTimestamp([
      ...run.events.map(event => event.timestamp),
      ...run.logs.map(log => log.timestamp),
      run.finishedAt,
      run.startedAt,
      run.createdAt,
    ], run.createdAt);
    const rootExecutionId = `external-cli-${run.runId}`;
    const agentStatus = statusOf(run.status);
    const threadStatus = threadStatusOf(run.status);
    const finishedAt = run.finishedAt ?? null;

    return {
      version: 1,
      rootExecutionId,
      nodes: [{
        id: rootExecutionId,
        sessionId: run.hadamardSessionId,
        rootExecutionId,
        parentExecutionId: null,
        parentSessionId: null,
        canonicalPath: `/external/${latest.runtime || 'cli'}/${run.nativeSessionId || run.hadamardSessionId}`,
        spawnOrder: 0,
        agentName: latest.configName || `${latest.runtime || 'External'} CLI`,
        nickname: latest.configName || null,
        role: `${latest.runtime || 'External'} CLI`,
        kind: 'root',
        runtime: latest.runtime || 'external-cli',
        model: latest.model,
        cwd: run.cwd,
        agentStatus,
        threadStatus,
        currentPlan: [],
        currentActivity: activityOf(latest, activityAt),
        runIds: ordered.map(item => item.run.runId),
        timestamps: {
          createdAt: first.run.createdAt,
          updatedAt: activityAt,
          startedAt: run.startedAt ?? run.createdAt,
          turnStartedAt: run.startedAt ?? null,
          turnCompletedAt: finishedAt,
          completedAt: finishedAt,
          interruptedAt: run.status === 'aborted' ? finishedAt : null,
          lastActivityAt: activityAt,
        },
        error: run.error?.message ?? null,
        result: run.result?.text ?? null,
      }],
      edges: [],
      events: [],
      seenEventIds: [],
      createdAt: first.run.createdAt,
      updatedAt: activityAt,
    };
  });
}
