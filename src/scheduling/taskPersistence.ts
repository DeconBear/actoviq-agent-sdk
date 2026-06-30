import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../runtime/helpers.js';
import type {
  ScheduledAutomationKind,
  ScheduledAutomationTask,
  ScheduledAutomationTaskInput,
  ScheduledTaskRecord,
} from '../types.js';
import { nextCronTime } from './cron.js';

interface ScheduledAutomationFile {
  version: 1;
  tasks: ScheduledAutomationTask[];
}

export function scheduledAutomationFilePath(workDir: string): string {
  return path.join(path.resolve(workDir), '.actoviq', 'scheduled-tasks.json');
}

export async function listScheduledAutomationTasks(workDir: string): Promise<ScheduledAutomationTask[]> {
  return (await readScheduledAutomationFile(workDir)).tasks;
}

export async function getScheduledAutomationTask(
  workDir: string,
  id: string,
): Promise<ScheduledAutomationTask | undefined> {
  return (await listScheduledAutomationTasks(workDir)).find(task => task.id === id);
}

export async function upsertScheduledAutomationTask(
  workDir: string,
  input: ScheduledAutomationTaskInput,
): Promise<ScheduledAutomationTask> {
  const file = await readScheduledAutomationFile(workDir);
  const existing = input.id ? file.tasks.find(task => task.id === input.id) : undefined;
  const task = normalizeScheduledAutomationTask(input, existing);
  file.tasks = [
    ...file.tasks.filter(item => item.id !== task.id),
    task,
  ].sort(compareScheduledAutomationTasks);
  await writeScheduledAutomationFile(workDir, file);
  return task;
}

export async function deleteScheduledAutomationTask(workDir: string, id: string): Promise<boolean> {
  const file = await readScheduledAutomationFile(workDir);
  const nextTasks = file.tasks.filter(task => task.id !== id);
  if (nextTasks.length === file.tasks.length) return false;
  await writeScheduledAutomationFile(workDir, { version: 1, tasks: nextTasks });
  return true;
}

export async function setScheduledAutomationEnabled(
  workDir: string,
  id: string,
  enabled: boolean,
): Promise<ScheduledAutomationTask | undefined> {
  const file = await readScheduledAutomationFile(workDir);
  const task = file.tasks.find(item => item.id === id);
  if (!task) return undefined;
  task.enabled = enabled;
  task.updatedAt = nowIso();
  if (enabled) task.nextRunAt = nextCronTime(task.cron).toISOString();
  await writeScheduledAutomationFile(workDir, file);
  return { ...task };
}

export async function recordScheduledAutomationRun(
  workDir: string,
  id: string,
  result: ScheduledTaskRecord['lastResult'],
  error?: string,
): Promise<ScheduledAutomationTask | undefined> {
  const file = await readScheduledAutomationFile(workDir);
  const task = file.tasks.find(item => item.id === id);
  if (!task) return undefined;
  const completedAt = nowIso();
  task.lastRunAt = completedAt;
  task.lastResult = result;
  if (error) task.lastError = error;
  else delete task.lastError;
  task.invocationCount += 1;
  task.nextRunAt = nextCronTime(task.cron, new Date(completedAt)).toISOString();
  task.updatedAt = completedAt;
  await writeScheduledAutomationFile(workDir, file);
  return { ...task };
}

function normalizeScheduledAutomationTask(
  input: ScheduledAutomationTaskInput,
  existing?: ScheduledAutomationTask,
): ScheduledAutomationTask {
  const now = nowIso();
  const kind: ScheduledAutomationKind = input.kind ?? existing?.kind ?? 'workflow';
  const cron = normalizeText(input.cron) || existing?.cron || '0 9 * * *';
  const nextRunAt = nextCronTime(cron).toISOString();
  const workflowName = kind === 'workflow'
    ? normalizeText(input.workflowName) || existing?.workflowName
    : undefined;
  const prompt = kind === 'prompt'
    ? normalizeText(input.prompt) || existing?.prompt
    : undefined;
  const name = normalizeText(input.name)
    || existing?.name
    || workflowName
    || (prompt ? prompt.slice(0, 48) : undefined)
    || 'Scheduled task';

  if (kind === 'workflow' && !workflowName) {
    throw new Error('Workflow tasks require workflowName');
  }
  if (kind === 'prompt' && !prompt) {
    throw new Error('Prompt tasks require prompt');
  }

  return {
    id: normalizeText(input.id) || existing?.id || createTaskId(name),
    name,
    kind,
    cron,
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(normalizeText(input.description) || existing?.description
      ? { description: normalizeText(input.description) || existing?.description }
      : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(kind === 'workflow' && input.input !== undefined
      ? { input: String(input.input) }
      : kind === 'workflow' && existing?.input !== undefined
        ? { input: existing.input }
        : {}),
    ...(prompt ? { prompt } : {}),
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    ...(existing?.lastResult ? { lastResult: existing.lastResult } : {}),
    ...(existing?.lastError ? { lastError: existing.lastError } : {}),
    nextRunAt,
    invocationCount: existing?.invocationCount ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function readScheduledAutomationFile(workDir: string): Promise<ScheduledAutomationFile> {
  const filePath = scheduledAutomationFilePath(workDir);
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.tasks)) return { version: 1, tasks: [] };
    return {
      version: 1,
      tasks: raw.tasks
        .map(coerceTask)
        .filter((task): task is ScheduledAutomationTask => Boolean(task))
        .sort(compareScheduledAutomationTasks),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, tasks: [] };
    throw error;
  }
}

async function writeScheduledAutomationFile(workDir: string, file: ScheduledAutomationFile): Promise<void> {
  const filePath = scheduledAutomationFilePath(workDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ version: 1, tasks: file.tasks }, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function coerceTask(value: unknown): ScheduledAutomationTask | undefined {
  if (!isRecord(value)) return undefined;
  const id = normalizeText(value.id);
  const name = normalizeText(value.name);
  const cron = normalizeText(value.cron);
  const kind = value.kind === 'prompt' ? 'prompt' : value.kind === 'workflow' ? 'workflow' : undefined;
  if (!id || !name || !cron || !kind) return undefined;
  try {
    nextCronTime(cron);
  } catch {
    return undefined;
  }
  return {
    id,
    name,
    kind,
    cron,
    enabled: value.enabled !== false,
    ...(normalizeText(value.description) ? { description: normalizeText(value.description) } : {}),
    ...(normalizeText(value.workflowName) ? { workflowName: normalizeText(value.workflowName) } : {}),
    ...(typeof value.input === 'string' ? { input: value.input } : {}),
    ...(normalizeText(value.prompt) ? { prompt: normalizeText(value.prompt) } : {}),
    ...(normalizeText(value.lastRunAt) ? { lastRunAt: normalizeText(value.lastRunAt) } : {}),
    ...(value.lastResult === 'success' || value.lastResult === 'failure' || value.lastResult === 'timeout'
      ? { lastResult: value.lastResult }
      : {}),
    ...(normalizeText(value.lastError) ? { lastError: normalizeText(value.lastError) } : {}),
    nextRunAt: normalizeText(value.nextRunAt) || nextCronTime(cron).toISOString(),
    invocationCount: typeof value.invocationCount === 'number' && Number.isFinite(value.invocationCount)
      ? Math.max(0, Math.floor(value.invocationCount))
      : 0,
    createdAt: normalizeText(value.createdAt) || nowIso(),
    updatedAt: normalizeText(value.updatedAt) || nowIso(),
  };
}

function createTaskId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
  return `${slug || 'task'}-${randomUUID().slice(0, 8)}`;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compareScheduledAutomationTasks(a: ScheduledAutomationTask, b: ScheduledAutomationTask): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
