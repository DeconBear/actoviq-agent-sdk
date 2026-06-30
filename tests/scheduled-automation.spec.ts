import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteScheduledAutomationTask,
  listScheduledAutomationTasks,
  recordScheduledAutomationRun,
  scheduledAutomationFilePath,
  setScheduledAutomationEnabled,
  upsertScheduledAutomationTask,
} from '../src/scheduling/index.js';

describe('scheduled automation persistence', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-scheduled-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('creates workflow tasks under the workspace .actoviq directory', async () => {
    const task = await upsertScheduledAutomationTask(workDir, {
      name: 'Daily review',
      kind: 'workflow',
      cron: '0 9 * * *',
      workflowName: 'review',
      input: 'summarize overnight changes',
    });

    expect(task.id).toMatch(/^daily-review-/);
    expect(task.enabled).toBe(true);
    expect(task.nextRunAt).toBeTruthy();

    const tasks = await listScheduledAutomationTasks(workDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: 'Daily review',
      kind: 'workflow',
      workflowName: 'review',
      input: 'summarize overnight changes',
    });

    const raw = JSON.parse(await readFile(scheduledAutomationFilePath(workDir), 'utf8')) as { tasks: unknown[] };
    expect(raw.tasks).toHaveLength(1);
  });

  it('validates cron and required task target fields', async () => {
    await expect(upsertScheduledAutomationTask(workDir, {
      name: 'bad cron',
      kind: 'workflow',
      cron: '* * *',
      workflowName: 'review',
    })).rejects.toThrow('5 fields');

    await expect(upsertScheduledAutomationTask(workDir, {
      name: 'missing workflow',
      kind: 'workflow',
      cron: '0 9 * * *',
    })).rejects.toThrow('workflowName');

    await expect(upsertScheduledAutomationTask(workDir, {
      name: 'missing prompt',
      kind: 'prompt',
      cron: '0 9 * * *',
    })).rejects.toThrow('Prompt tasks require prompt');
  });

  it('toggles enabled state and records run results', async () => {
    const created = await upsertScheduledAutomationTask(workDir, {
      name: 'Daily prompt',
      kind: 'prompt',
      cron: '*/5 * * * *',
      prompt: 'Write a short status note',
    });

    const paused = await setScheduledAutomationEnabled(workDir, created.id, false);
    expect(paused?.enabled).toBe(false);

    const recorded = await recordScheduledAutomationRun(workDir, created.id, 'failure', 'boom');
    expect(recorded?.lastResult).toBe('failure');
    expect(recorded?.lastError).toBe('boom');
    expect(recorded?.invocationCount).toBe(1);

    const listed = await listScheduledAutomationTasks(workDir);
    expect(listed[0]?.enabled).toBe(false);
    expect(listed[0]?.lastError).toBe('boom');
  });

  it('deletes tasks', async () => {
    const task = await upsertScheduledAutomationTask(workDir, {
      name: 'Delete me',
      kind: 'workflow',
      cron: '0 9 * * *',
      workflowName: 'cleanup',
    });

    await expect(deleteScheduledAutomationTask(workDir, task.id)).resolves.toBe(true);
    await expect(deleteScheduledAutomationTask(workDir, task.id)).resolves.toBe(false);
    await expect(listScheduledAutomationTasks(workDir)).resolves.toEqual([]);
  });
});
