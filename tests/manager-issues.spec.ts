import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDecomposeIssuePrompt,
  buildManagerSystemPrompt,
  createManagerTools,
} from '../src/manager/projectManager.js';
import { listProjectIssues } from '../src/issues/issueStore.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function context(cwd: string): ToolExecutionContext {
  return {
    runId: 'manager-issue-test',
    cwd,
    metadata: {},
    prompt: 'test',
    iteration: 1,
  };
}

function getTool(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe('Project Manager issue tools', () => {
  it('lets the manager create, inspect, update, and comment without owning in_progress dispatch', async () => {
    const root = await tempRoot('actoviq-manager-issues-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const tools = await createManagerTools({ workDir, homeDir, issueStorageMode: 'workspace' });
    const ctx = context(workDir);

    const IssueCreate = getTool(tools, 'IssueCreate');
    const IssueList = getTool(tools, 'IssueList');
    const IssueGet = getTool(tools, 'IssueGet');
    const IssueUpdate = getTool(tools, 'IssueUpdate');
    const IssueComment = getTool(tools, 'IssueComment');

    const created = await IssueCreate.execute({
      title: 'Add worker review path',
      description: 'Dispatch an issue to an agent and require explicit reporting.',
      status: 'backlog',
      priority: 'high',
      labels: ['manager', 'issues'],
      acceptanceCriteria: ['Worker calls IssueReport before ending.'],
      agentConfig: 'Claude reviewer',
    }, ctx) as { issue: { id: string; number: number; status: string; createdBy: string } };

    expect(created.issue.number).toBe(1);
    expect(created.issue.status).toBe('backlog');
    expect(created.issue.createdBy).toBe('manager');

    const listed = await IssueList.execute({ includeClosed: true }, ctx) as { issues: Array<{ key: string; title: string }> };
    expect(listed.issues).toEqual([
      expect.objectContaining({ key: 'ISS-1', title: 'Add worker review path' }),
    ]);

    const got = await IssueGet.execute({ id: 'ISS-1' }, ctx) as { issue: { id: string; agentConfig?: string } | null };
    expect(got.issue).toMatchObject({ id: created.issue.id, agentConfig: 'Claude reviewer' });

    const movedToTodo = await IssueUpdate.execute({
      id: 1,
      status: 'todo',
      title: 'Add issue worker review path',
      brief: 'Use a dedicated worker session.',
    }, ctx) as { issue: { status: string; title: string; brief?: string } };
    expect(movedToTodo.issue).toMatchObject({
      status: 'todo',
      title: 'Add issue worker review path',
      brief: 'Use a dedicated worker session.',
    });

    await expect(IssueUpdate.execute({ id: 1, status: 'in_progress' }, ctx)).rejects.toThrow(
      'Manager cannot set in_progress',
    );

    const commented = await IssueComment.execute({
      id: '1',
      body: 'Ready for worker dispatch.',
      kind: 'progress',
    }, ctx) as { issue: { comments: Array<{ body: string; kind: string; actor: string }> } };
    expect(commented.issue.comments.at(-1)).toMatchObject({
      body: 'Ready for worker dispatch.',
      kind: 'progress',
      actor: 'manager',
    });

    const persisted = await listProjectIssues(workDir, homeDir, 'workspace');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ status: 'todo', title: 'Add issue worker review path' });
  });

  it('teaches the manager and worker handoff prompts to use the issue board and IssueReport', async () => {
    const root = await tempRoot('actoviq-manager-issue-prompt-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const tools = await createManagerTools({ workDir, homeDir });
    const issue = (await getTool(tools, 'IssueCreate').execute({
      title: 'Verify model team review',
      acceptanceCriteria: ['Reviewer signs off on the final result.'],
    }, context(workDir)) as { issue: Parameters<typeof buildDecomposeIssuePrompt>[0] }).issue;

    const systemPrompt = buildManagerSystemPrompt(workDir);
    expect(systemPrompt).toContain('IssueList, IssueGet, IssueCreate, IssueUpdate, and IssueComment');
    expect(systemPrompt).toContain('Never move an issue to in_progress');

    const workerPrompt = buildDecomposeIssuePrompt(issue, {
      currentPlanJson: '{"today":["review teams"]}',
      currentProgress: 'Current risk: reviewer unavailable.',
    });
    expect(workerPrompt).toContain('ISS-1');
    expect(workerPrompt).toContain('Reviewer signs off on the final result.');
    expect(workerPrompt).toContain('IssueReport with status="in_review"');
    expect(workerPrompt).toContain('Current plan.json');
    expect(workerPrompt).toContain('Current PROGRESS.md');
  });
});
