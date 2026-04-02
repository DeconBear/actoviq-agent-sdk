import { RunAbortedError } from '../errors.js';
import type {
  ActoviqBackgroundTaskRecord,
  WaitForActoviqBackgroundTaskOptions,
} from '../types.js';
import type { BackgroundTaskStore } from '../storage/backgroundTaskStore.js';
import { asError, nowIso, signalAborted } from './helpers.js';

interface LaunchActoviqBackgroundTaskOptions {
  subagentType: string;
  description: string;
  workDir: string;
  parentRunId?: string;
  parentSessionId?: string;
  onRun: (signal: AbortSignal) => Promise<{
    runId: string;
    sessionId?: string;
    model: string;
    text: string;
    toolCallCount: number;
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ActoviqBackgroundTaskHandle {
  constructor(
    private readonly manager: ActoviqBackgroundTaskManager,
    readonly id: string,
  ) {}

  state(): Promise<ActoviqBackgroundTaskRecord | undefined> {
    return this.manager.get(this.id);
  }

  wait(options: WaitForActoviqBackgroundTaskOptions = {}): Promise<ActoviqBackgroundTaskRecord> {
    return this.manager.wait(this.id, options);
  }

  cancel(): Promise<ActoviqBackgroundTaskRecord | undefined> {
    return this.manager.cancel(this.id);
  }
}

export class ActoviqBackgroundTasksApi {
  constructor(private readonly manager: ActoviqBackgroundTaskManager) {}

  list(): Promise<ActoviqBackgroundTaskRecord[]> {
    return this.manager.list();
  }

  get(taskId: string): Promise<ActoviqBackgroundTaskRecord | undefined> {
    return this.manager.get(taskId);
  }

  use(taskId: string): ActoviqBackgroundTaskHandle {
    return new ActoviqBackgroundTaskHandle(this.manager, taskId);
  }

  wait(
    taskId: string,
    options: WaitForActoviqBackgroundTaskOptions = {},
  ): Promise<ActoviqBackgroundTaskRecord> {
    return this.manager.wait(taskId, options);
  }

  cancel(taskId: string): Promise<ActoviqBackgroundTaskRecord | undefined> {
    return this.manager.cancel(taskId);
  }
}

export class ActoviqBackgroundTaskManager {
  private readonly taskPromises = new Map<string, Promise<ActoviqBackgroundTaskRecord>>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly store: BackgroundTaskStore) {}

  async launch(
    options: LaunchActoviqBackgroundTaskOptions,
  ): Promise<ActoviqBackgroundTaskRecord> {
    const createdAt = nowIso();
    let task = await this.store.create({
      status: 'queued',
      description: options.description,
      subagentType: options.subagentType,
      outputFile: '',
      workDir: options.workDir,
      createdAt,
      updatedAt: createdAt,
      parentRunId: options.parentRunId,
      parentSessionId: options.parentSessionId,
    });
    task = {
      ...task,
      outputFile: this.store.taskPath(task.id),
    };
    await this.store.save(task);

    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    this.taskPromises.set(
      task.id,
      this.runTask(task.id, abortController, options),
    );

    return task;
  }

  async list(): Promise<ActoviqBackgroundTaskRecord[]> {
    return this.store.list();
  }

  async get(taskId: string): Promise<ActoviqBackgroundTaskRecord | undefined> {
    return this.store.load(taskId);
  }

  async wait(
    taskId: string,
    options: WaitForActoviqBackgroundTaskOptions = {},
  ): Promise<ActoviqBackgroundTaskRecord> {
    const inMemory = this.taskPromises.get(taskId);
    if (inMemory) {
      if (options.timeoutMs == null) {
        return inMemory;
      }
      return Promise.race([
        inMemory,
        new Promise<ActoviqBackgroundTaskRecord>((_, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for task ${taskId}.`));
          }, options.timeoutMs);
          void inMemory.finally(() => clearTimeout(timeout));
        }),
      ]);
    }

    const timeoutAt = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
    const pollIntervalMs = options.pollIntervalMs ?? 500;

    while (true) {
      signalAborted(options.signal);
      const task = await this.store.load(taskId);
      if (!task) {
        throw new Error(`No background task with id "${taskId}" exists.`);
      }
      if (
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'cancelled'
      ) {
        return task;
      }
      if (timeoutAt != null && Date.now() >= timeoutAt) {
        throw new Error(`Timed out waiting for task ${taskId}.`);
      }
      await delay(pollIntervalMs);
    }
  }

  async cancel(taskId: string): Promise<ActoviqBackgroundTaskRecord | undefined> {
    const existing = await this.store.load(taskId);
    if (!existing) {
      return undefined;
    }
    const controller = this.abortControllers.get(taskId);
    controller?.abort();
    const next: ActoviqBackgroundTaskRecord =
      existing.status === 'completed' || existing.status === 'failed'
        ? existing
        : {
            ...existing,
            status: 'cancelled',
            updatedAt: nowIso(),
            completedAt: nowIso(),
            error: existing.error ?? 'Cancelled.',
          };
    await this.store.save(next);
    return next;
  }

  private async runTask(
    taskId: string,
    abortController: AbortController,
    options: LaunchActoviqBackgroundTaskOptions,
  ): Promise<ActoviqBackgroundTaskRecord> {
    let current = await this.requireTask(taskId);
    current = {
      ...current,
      status: 'running',
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.store.save(current);

    try {
      const result = await options.onRun(abortController.signal);
      const completed: ActoviqBackgroundTaskRecord = {
        ...current,
        status: 'completed',
        updatedAt: nowIso(),
        completedAt: nowIso(),
        runId: result.runId,
        sessionId: result.sessionId,
        model: result.model,
        text: result.text,
        toolCallCount: result.toolCallCount,
      };
      await this.store.save(completed);
      return completed;
    } catch (error) {
      const normalized = asError(error);
      const cancelled =
        normalized instanceof RunAbortedError || abortController.signal.aborted;
      const failed: ActoviqBackgroundTaskRecord = {
        ...current,
        status: cancelled ? 'cancelled' : 'failed',
        updatedAt: nowIso(),
        completedAt: nowIso(),
        error: normalized.message,
      };
      await this.store.save(failed);
      return failed;
    } finally {
      this.abortControllers.delete(taskId);
      this.taskPromises.delete(taskId);
    }
  }

  private async requireTask(taskId: string): Promise<ActoviqBackgroundTaskRecord> {
    const task = await this.store.load(taskId);
    if (!task) {
      throw new Error(`No background task with id "${taskId}" exists.`);
    }
    return task;
  }
}
