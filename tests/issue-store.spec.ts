import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addIssueComment,
  applyIssueTransition,
  createProjectIssue,
  listProjectIssues,
  migrateIssueStore,
  readIssueStore,
  resolveIssueStorePath,
  transitionProjectIssue,
  updateProjectIssue,
  writeIssueStore,
  type ProjectIssue,
} from '../src/issues/issueStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('issueStore', () => {
  it('creates issues with incrementing numbers and persists normalized fields', async () => {
    const root = await tempRoot('actoviq-issues-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });

    const first = await createProjectIssue(workDir, homeDir, {
      title: '  Wire API  ',
      description: ' endpoint ',
      priority: 'high',
      labels: ['backend', 'backend', ' api '],
      acceptanceCriteria: ['works', ' tested '],
      metadata: { ok: true, count: 2, nested: {} as never },
    });
    const second = await createProjectIssue(workDir, homeDir, { title: 'Build UI', status: 'backlog' });

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(first.title).toBe('Wire API');
    expect(first.labels).toEqual(['backend', 'api']);
    expect(first.acceptanceCriteria).toEqual(['works', 'tested']);
    expect(first.metadata).toEqual({ ok: true, count: 2 });
    expect(second.status).toBe('backlog');

    const stored = await readIssueStore(workDir, homeDir);
    expect(stored.nextNumber).toBe(3);
    expect(stored.issues.map(issue => issue.number)).toEqual([1, 2]);
    await expect(readFile(resolveIssueStorePath(workDir, homeDir), 'utf8')).resolves.toContain('Wire API');
  });

  it('updates fields and appends comments', async () => {
    const root = await tempRoot('actoviq-issues-update-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });

    const issue = await createProjectIssue(workDir, homeDir, { title: 'Initial' });
    const updated = await updateProjectIssue(workDir, homeDir, issue.id, {
      title: 'Updated',
      priority: 'medium',
      sessionIds: ['s1', 's1', 's2'],
      activeSessionId: 's2',
    });
    const commented = await addIssueComment(workDir, homeDir, issue.number, {
      actor: 'manager',
      kind: 'progress',
      body: ' split into two steps ',
    });

    expect(updated?.title).toBe('Updated');
    expect(updated?.sessionIds).toEqual(['s1', 's2']);
    expect(commented?.comments).toHaveLength(1);
    expect(commented?.comments[0]).toMatchObject({ actor: 'manager', kind: 'progress', body: 'split into two steps' });
  });

  it('guards lifecycle transitions and records status-change comments', async () => {
    const root = await tempRoot('actoviq-issues-transition-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });

    const issue = await createProjectIssue(workDir, homeDir, { title: 'Run task' });
    const running = await transitionProjectIssue(workDir, homeDir, issue.number, 'in_progress', 'system');
    const review = await transitionProjectIssue(workDir, homeDir, issue.number, 'in_review', 'agent');

    expect(running?.status).toBe('in_progress');
    expect(running?.startedAt).toBeTruthy();
    expect(review?.comments.at(-1)).toMatchObject({
      kind: 'status_change',
      actor: 'agent',
      fromStatus: 'in_progress',
      toStatus: 'in_review',
    });
    expect(() => applyIssueTransition(review!, 'cancelled', 'user')).toThrow('Invalid issue transition');
  });

  it('migrates between home and workspace stores while deduping by issue number', async () => {
    const root = await tempRoot('actoviq-issues-migrate-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });

    const sourceIssue = await createProjectIssue(workDir, homeDir, { title: 'Home issue' }, 'home');
    const targetDuplicate: ProjectIssue = {
      ...sourceIssue,
      title: 'Workspace duplicate wins',
      updatedAt: '2999-01-01T00:00:00.000Z',
      comments: [],
    };
    await writeIssueStore(workDir, homeDir, {
      version: 1,
      nextNumber: 2,
      issues: [targetDuplicate],
    }, 'workspace');

    const migrated = await migrateIssueStore({ workDir, homeDir, from: 'home', to: 'workspace' });

    expect(migrated.issues).toHaveLength(1);
    expect(migrated.issues[0]?.title).toBe('Workspace duplicate wins');
    expect(migrated.nextNumber).toBe(2);
    await expect(readFile(resolveIssueStorePath(workDir, homeDir, 'home'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listProjectIssues(workDir, homeDir, 'workspace')).toHaveLength(1);
  });
});
