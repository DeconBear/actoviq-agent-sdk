import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  executeProjectIssue,
  type ExecuteProjectIssueOptions,
} from '../src/issues/issueExecution.js';
import {
  createProjectIssue,
  listProjectIssues,
} from '../src/issues/issueStore.js';
import type { AgentSession } from '../src/runtime/agentSession.js';
import type { ActoviqAgentClient } from '../src/runtime/agentClient.js';
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentToolDefinition,
  ToolExecutionContext,
} from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runResult(text: string, runId: string): AgentRunResult {
  const timestamp = new Date().toISOString();
  return {
    runId,
    model: 'mock-model',
    text,
    message: {
      id: `msg-${runId}`,
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: text ? [{ type: 'text', text }] : [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    messages: [],
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    requests: [],
    toolCalls: [],
    permissionDecisions: [],
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

function streamOf(
  result: AgentRunResult,
  beforeComplete?: () => Promise<void>,
  error?: Error,
) {
  return {
    result: Promise.resolve(result),
    async *[Symbol.asyncIterator]() {
      await beforeComplete?.();
      if (error) throw error;
    },
  };
}

function toolContext(cwd: string): ToolExecutionContext {
  return {
    runId: 'issue-execution-test',
    sessionId: 'worker-session',
    cwd,
    metadata: {},
    prompt: 'test',
    iteration: 1,
  };
}

function toolByName(options: AgentRunOptions, name: string): AgentToolDefinition {
  const found = options.tools?.find(tool => tool.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

async function fixture(
  workerBehavior: (options: AgentRunOptions, workDir: string) => ReturnType<typeof streamOf>,
  reconcile?: (options: AgentRunOptions, workDir: string) => Promise<void>,
) {
  const root = await tempRoot('actoviq-issue-execution-');
  const workDir = path.join(root, 'work');
  const homeDir = path.join(root, 'home');
  const issue = await createProjectIssue(workDir, homeDir, {
    title: 'Implement the issue workflow',
    description: 'Exercise decomposition, execution, and reporting.',
    acceptanceCriteria: ['The issue reaches a deterministic terminal handoff state.'],
  }, 'workspace');

  let managerTurns = 0;
  const managerSession = {
    stream(_input: unknown, options: AgentRunOptions) {
      managerTurns += 1;
      if (managerTurns === 1) {
        return streamOf(runResult('# Worker brief\n\nImplement and verify the workflow.', 'manager-decompose'));
      }
      return streamOf(
        runResult('Reconciled.', 'manager-reconcile'),
        reconcile ? () => reconcile(options, workDir) : undefined,
      );
    },
  } as unknown as AgentSession;

  let createdSessionOptions: Record<string, unknown> | undefined;
  const workerSession = {
    id: 'worker-session',
    stream(_input: unknown, options: AgentRunOptions) {
      return workerBehavior(options, workDir);
    },
  } as unknown as AgentSession;
  const sdk = {
    async createSession(options: Record<string, unknown>) {
      createdSessionOptions = options;
      return workerSession;
    },
  } as unknown as ActoviqAgentClient;

  const options: ExecuteProjectIssueOptions = {
    sdk,
    managerSession,
    workDir,
    homeDir,
    storageMode: 'workspace',
    issue,
    defaultModel: 'mock-model',
    permissionMode: 'bypassPermissions',
  };
  return {
    options,
    workDir,
    homeDir,
    getManagerTurns: () => managerTurns,
    getCreatedSessionOptions: () => createdSessionOptions,
  };
}

describe('issue execution lifecycle', () => {
  it('stores the manager brief and moves the issue to review through IssueReport', async () => {
    const test = await fixture((options, workDir) => streamOf(
      runResult('Implementation complete.', 'worker'),
      async () => {
        await toolByName(options, 'IssueReport').execute({
          status: 'in_review',
          summary: 'Implemented the workflow and ran focused tests.',
          followUps: ['Review the final diff.'],
        }, toolContext(workDir));
      },
    ));

    const result = await executeProjectIssue(test.options);
    const persisted = (await listProjectIssues(test.workDir, test.homeDir, 'workspace'))[0]!;

    expect(result.reported).toBe(true);
    expect(result.brief).toContain('Worker brief');
    expect(persisted).toMatchObject({
      status: 'in_review',
      brief: expect.stringContaining('Worker brief'),
      activeSessionId: 'worker-session',
      sessionIds: ['worker-session'],
    });
    expect(persisted.comments.some(comment =>
      comment.kind === 'progress' && comment.body.includes('ran focused tests'),
    )).toBe(true);
    expect(test.getCreatedSessionOptions()?.metadata).toMatchObject({
      __actoviqIssueId: persisted.id,
      __actoviqIssueKey: 'ISS-1',
    });
  });

  it('resets an unreported issue to todo when the worker run fails', async () => {
    const test = await fixture(() => streamOf(
      runResult('', 'worker-failed'),
      undefined,
      new Error('worker transport failed'),
    ));

    await expect(executeProjectIssue(test.options)).rejects.toThrow('worker transport failed');
    const persisted = (await listProjectIssues(test.workDir, test.homeDir, 'workspace'))[0]!;

    expect(persisted.status).toBe('todo');
    expect(persisted.comments.some(comment =>
      comment.kind === 'system' && comment.body.includes('worker transport failed'),
    )).toBe(true);
  });

  it('runs one manager reconciliation turn when the worker ends without IssueReport', async () => {
    const test = await fixture(
      () => streamOf(runResult('Work appears complete but no report was emitted.', 'worker-no-report')),
      async (options, workDir) => {
        await toolByName(options, 'IssueUpdate').execute({
          id: 'ISS-1',
          status: 'in_review',
        }, toolContext(workDir));
        await toolByName(options, 'IssueComment').execute({
          id: 'ISS-1',
          kind: 'progress',
          body: 'Reconciled from worker verification evidence.',
        }, toolContext(workDir));
      },
    );

    const result = await executeProjectIssue(test.options);
    const persisted = (await listProjectIssues(test.workDir, test.homeDir, 'workspace'))[0]!;

    expect(result.reported).toBe(false);
    expect(test.getManagerTurns()).toBe(2);
    expect(persisted.status).toBe('in_review');
    expect(persisted.comments.some(comment =>
      comment.actor === 'manager' && comment.body.includes('verification evidence'),
    )).toBe(true);
  });

  it('safely resets to todo when reconciliation does not settle the issue', async () => {
    const test = await fixture(
      () => streamOf(runResult('No IssueReport was emitted.', 'worker-unsettled')),
    );

    await executeProjectIssue(test.options);
    const persisted = (await listProjectIssues(test.workDir, test.homeDir, 'workspace'))[0]!;

    expect(test.getManagerTurns()).toBe(2);
    expect(persisted.status).toBe('todo');
    expect(persisted.comments.some(comment =>
      comment.kind === 'system' && comment.body.includes('safe redispatch'),
    )).toBe(true);
  });
});
