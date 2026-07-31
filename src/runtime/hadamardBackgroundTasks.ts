import { RunAbortedError } from '../errors.js';
import type {
  HadamardBackgroundTaskRecord,
  HadamardBackgroundTaskQueuedInput,
  WaitForHadamardBackgroundTaskOptions,
} from '../types.js';
import type { BackgroundTaskStore } from '../storage/backgroundTaskStore.js';
import { asError, createId, nowIso, signalAborted } from './helpers.js';

const MAX_QUEUED_INPUTS = 1_000;
const MAX_SEEN_INPUT_IDS = 10_000;
const OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
const OWNER_HEARTBEAT_STALE_MS = 30_000;
const ACTIVE_BACKGROUND_TASK_OWNERS = new Map<string, Set<string>>();

interface LaunchHadamardBackgroundTaskOptions {
  subagentType: string;
  description: string;
  workDir: string;
  parentRunId?: string;
  parentSessionId?: string;
  sessionId?: string;
  executionId?: string;
  executionNodeId?: string;
  agentName?: string;
  resumedFromTaskId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  outputFile?: string | ((taskId: string) => string);
  seenInputIds?: string[];
  onRun: (
    signal: AbortSignal,
    updateProgress: (
      progress: Partial<
        Pick<
          HadamardBackgroundTaskRecord,
          | 'partialText'
          | 'toolCallCount'
          | 'toolErrorCount'
          | 'requestCount'
          | 'currentIteration'
          | 'currentToolName'
          | 'progressSummary'
          | 'queuedMessageCount'
        >
      >,
    ) => Promise<HadamardBackgroundTaskRecord>,
    task: HadamardBackgroundTaskRecord,
  ) => Promise<{
    runId: string;
    sessionId?: string;
    model: string;
    text: string;
    toolCallCount: number;
    toolErrorCount?: number;
    requestCount?: number;
    retainedWorktree?: boolean;
    worktreePath?: string;
    worktreeBranch?: string;
  }>;
  onSettled?: (task: HadamardBackgroundTaskRecord) => Promise<void> | void;
}

export interface ReserveHadamardBackgroundTaskInputResult {
  task: HadamardBackgroundTaskRecord;
  input: HadamardBackgroundTaskQueuedInput;
  accepted: boolean;
  queued: boolean;
  rejected?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminalTask(task: HadamardBackgroundTaskRecord): boolean {
  return (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled'
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isOwnerLeaseFresh(task: HadamardBackgroundTaskRecord): boolean {
  const heartbeat = Date.parse(
    task.ownerHeartbeatAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt,
  );
  return Number.isFinite(heartbeat) && Date.now() - heartbeat <= OWNER_HEARTBEAT_STALE_MS;
}

function isTaskOwnerAlive(task: HadamardBackgroundTaskRecord): boolean {
  if (task.ownerPid === undefined) {
    return false;
  }
  if (task.ownerPid === process.pid) {
    return Boolean(
      task.ownerInstanceId &&
      ACTIVE_BACKGROUND_TASK_OWNERS.get(task.ownerInstanceId)?.has(task.id),
    );
  }
  return isProcessAlive(task.ownerPid) && isOwnerLeaseFresh(task);
}

function boundedUnique(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(-limit);
}

export class HadamardBackgroundTaskHandle {
  constructor(
    private readonly manager: HadamardBackgroundTaskManager,
    readonly id: string,
  ) {}

  state(): Promise<HadamardBackgroundTaskRecord | undefined> {
    return this.manager.get(this.id);
  }

  wait(options: WaitForHadamardBackgroundTaskOptions = {}): Promise<HadamardBackgroundTaskRecord> {
    return this.manager.wait(this.id, options);
  }

  cancel(): Promise<HadamardBackgroundTaskRecord | undefined> {
    return this.manager.cancel(this.id);
  }
}

export class HadamardBackgroundTasksApi {
  constructor(private readonly manager: HadamardBackgroundTaskManager) {}

  list(): Promise<HadamardBackgroundTaskRecord[]> {
    return this.manager.list();
  }

  get(taskId: string): Promise<HadamardBackgroundTaskRecord | undefined> {
    return this.manager.get(taskId);
  }

  use(taskId: string): HadamardBackgroundTaskHandle {
    return new HadamardBackgroundTaskHandle(this.manager, taskId);
  }

  wait(
    taskId: string,
    options: WaitForHadamardBackgroundTaskOptions = {},
  ): Promise<HadamardBackgroundTaskRecord> {
    return this.manager.wait(taskId, options);
  }

  cancel(taskId: string): Promise<HadamardBackgroundTaskRecord | undefined> {
    return this.manager.cancel(taskId);
  }
}

export class HadamardBackgroundTaskManager {
  private readonly taskPromises = new Map<string, Promise<HadamardBackgroundTaskRecord>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly instanceId = createId();

  constructor(private readonly store: BackgroundTaskStore) {
    ACTIVE_BACKGROUND_TASK_OWNERS.set(this.instanceId, new Set());
  }

  async launch(
    options: LaunchHadamardBackgroundTaskOptions,
  ): Promise<HadamardBackgroundTaskRecord> {
    const ownedTasks = ACTIVE_BACKGROUND_TASK_OWNERS.get(this.instanceId) ?? new Set<string>();
    ACTIVE_BACKGROUND_TASK_OWNERS.set(this.instanceId, ownedTasks);
    const createdAt = nowIso();
    let task = await this.store.create({
      status: 'queued',
      ownerPid: process.pid,
      ownerInstanceId: this.instanceId,
      ownerHeartbeatAt: createdAt,
      seenInputIds: boundedUnique(options.seenInputIds ?? [], MAX_SEEN_INPUT_IDS),
      description: options.description,
      subagentType: options.subagentType,
      outputFile: '',
      workDir: options.workDir,
      createdAt,
      updatedAt: createdAt,
      parentRunId: options.parentRunId,
      parentSessionId: options.parentSessionId,
      sessionId: options.sessionId,
      executionId: options.executionId,
      executionNodeId: options.executionNodeId,
      agentName: options.agentName,
      resumedFromTaskId: options.resumedFromTaskId,
      worktreePath: options.worktreePath,
      worktreeBranch: options.worktreeBranch,
    });
    ownedTasks.add(task.id);
    let configuredTask: HadamardBackgroundTaskRecord | undefined;
    try {
      configuredTask = await this.store.mutate(task.id, current => ({
        ...current,
        outputFile:
          typeof options.outputFile === 'function'
            ? options.outputFile(current.id)
            : options.outputFile ?? this.store.taskPath(current.id),
      }));
    } catch (error) {
      const normalized = asError(error);
      await this.store.mutate(task.id, current => ({
        ...current,
        status: 'failed',
        completedAt: nowIso(),
        updatedAt: nowIso(),
        error: normalized.message,
      })).catch(() => undefined);
      ownedTasks.delete(task.id);
      throw error;
    }
    if (!configuredTask) {
      ownedTasks.delete(task.id);
      throw new Error(`No background task with id "${task.id}" exists.`);
    }
    task = configuredTask;

    const abortController = new AbortController();
    this.abortControllers.set(task.id, abortController);
    this.taskPromises.set(
      task.id,
      this.runTask(task.id, abortController, options),
    );

    return task;
  }

  async list(): Promise<HadamardBackgroundTaskRecord[]> {
    return this.store.list();
  }

  async get(taskId: string): Promise<HadamardBackgroundTaskRecord | undefined> {
    return this.store.load(taskId);
  }

  async updateProgress(
    taskId: string,
    progress: Partial<
      Pick<
        HadamardBackgroundTaskRecord,
        | 'partialText'
        | 'toolCallCount'
        | 'toolErrorCount'
        | 'requestCount'
        | 'currentIteration'
        | 'currentToolName'
        | 'progressSummary'
        | 'queuedMessageCount'
      >
    >,
  ): Promise<HadamardBackgroundTaskRecord> {
    return this.mutateTask(taskId, task => {
      if (task.status !== 'queued' && task.status !== 'running') {
        return task;
      }
      return {
        ...task,
        ...progress,
        updatedAt: nowIso(),
      };
    });
  }

  async reserveInput(
    taskId: string,
    input: HadamardBackgroundTaskQueuedInput,
  ): Promise<ReserveHadamardBackgroundTaskInputResult> {
    let accepted = false;
    let queued = false;
    let rejected: string | undefined;
    const task = await this.mutateTask(taskId, current => {
      const seenInputIds = current.seenInputIds ?? [];
      if (seenInputIds.includes(input.id)) {
        return current;
      }
      const isActive = current.status === 'queued' || current.status === 'running';
      const queuedInputs = current.queuedInputs ?? [];
      if (isActive && queuedInputs.length >= MAX_QUEUED_INPUTS) {
        rejected =
          `Background task ${taskId} already has ${MAX_QUEUED_INPUTS} queued messages.`;
        return {
          ...current,
          seenInputIds: boundedUnique([...seenInputIds, input.id], MAX_SEEN_INPUT_IDS),
          updatedAt: nowIso(),
        };
      }
      accepted = true;
      queued = isActive;
      const nextQueuedInputs = isActive ? [...queuedInputs, input] : queuedInputs;
      return {
        ...current,
        seenInputIds: boundedUnique([...seenInputIds, input.id], MAX_SEEN_INPUT_IDS),
        ...(isActive ? { queuedInputs: nextQueuedInputs } : {}),
        queuedMessageCount: nextQueuedInputs.length,
        ...(isActive ? { progressSummary: 'Queued follow-up message.' } : {}),
        updatedAt: nowIso(),
      };
    });
    return { task, input, accepted, queued, rejected };
  }

  async drainInputs(taskId: string): Promise<HadamardBackgroundTaskQueuedInput[]> {
    let drained: HadamardBackgroundTaskQueuedInput[] = [];
    await this.mutateTask(taskId, current => {
      drained = [...(current.queuedInputs ?? [])];
      if (drained.length === 0 && (current.queuedMessageCount ?? 0) === 0) {
        return current;
      }
      return {
        ...current,
        queuedInputs: [],
        queuedMessageCount: 0,
        updatedAt: nowIso(),
      };
    });
    return drained;
  }

  async reconcileInterruptedTasks(): Promise<HadamardBackgroundTaskRecord[]> {
    const reconciled: HadamardBackgroundTaskRecord[] = [];
    for (const task of await this.store.list()) {
      if (
        (task.status !== 'queued' && task.status !== 'running') ||
        this.taskPromises.has(task.id) ||
        isTaskOwnerAlive(task)
      ) {
        continue;
      }
      let didReconcile = false;
      const updated = await this.mutateTask(task.id, current => {
        if (
          (current.status !== 'queued' && current.status !== 'running') ||
          this.taskPromises.has(current.id) ||
          isTaskOwnerAlive(current)
        ) {
          return current;
        }
        didReconcile = true;
        return {
          ...current,
          status: 'failed',
          completedAt: nowIso(),
          updatedAt: nowIso(),
          error:
            current.error ?? 'Background execution was interrupted by a runtime restart.',
        };
      });
      if (didReconcile) {
        reconciled.push(updated);
      }
    }
    return reconciled;
  }

  async cancelAll(): Promise<void> {
    const errors: unknown[] = [];
    try {
      const ids = [...this.abortControllers.keys()];
      const cancellations = await Promise.allSettled(ids.map(taskId => this.cancel(taskId)));
      errors.push(...cancellations.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      ));
      await Promise.allSettled([...this.taskPromises.values()]);
    } finally {
      ACTIVE_BACKGROUND_TASK_OWNERS.delete(this.instanceId);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to cancel all background tasks.');
    }
  }

  async wait(
    taskId: string,
    options: WaitForHadamardBackgroundTaskOptions = {},
  ): Promise<HadamardBackgroundTaskRecord> {
    const inMemory = this.taskPromises.get(taskId);
    if (inMemory) {
      if (options.timeoutMs == null) {
        return inMemory;
      }
      return Promise.race([
        inMemory,
        new Promise<HadamardBackgroundTaskRecord>((_, reject) => {
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

  async cancel(taskId: string): Promise<HadamardBackgroundTaskRecord | undefined> {
    const controller = this.abortControllers.get(taskId);
    controller?.abort();
    return this.store.mutate(taskId, task => {
      if (isTerminalTask(task)) {
        return task;
      }
      return {
        ...task,
        status: 'cancelled',
        updatedAt: nowIso(),
        completedAt: nowIso(),
        error: task.error ?? 'Cancelled.',
      };
    });
  }

  private async runTask(
    taskId: string,
    abortController: AbortController,
    options: LaunchHadamardBackgroundTaskOptions,
  ): Promise<HadamardBackgroundTaskRecord> {
    let stopHeartbeat = (): void => undefined;
    try {
      const current = await this.mutateTask(taskId, task => {
        if (isTerminalTask(task)) {
          return task;
        }
        if (abortController.signal.aborted) {
          return {
            ...task,
            status: 'cancelled',
            updatedAt: nowIso(),
            completedAt: task.completedAt ?? nowIso(),
            error: task.error ?? 'Cancelled.',
          };
        }
        return {
          ...task,
          status: 'running',
          startedAt: task.startedAt ?? nowIso(),
          updatedAt: nowIso(),
        };
      });

      if (current.status !== 'running') {
        await this.notifySettled(options, current);
        return current;
      }

      stopHeartbeat = this.startOwnerHeartbeat(taskId);
      try {
        const result = await options.onRun(
          abortController.signal,
          progress => this.updateProgress(taskId, progress),
          current,
        );
        const completed = await this.mutateTask(taskId, task => {
          if (isTerminalTask(task)) {
            return task;
          }
          if (abortController.signal.aborted) {
            return {
              ...task,
              status: 'cancelled',
              updatedAt: nowIso(),
              completedAt: task.completedAt ?? nowIso(),
              error: task.error ?? 'Cancelled.',
            };
          }
          return {
            ...task,
            status: 'completed',
            updatedAt: nowIso(),
            completedAt: nowIso(),
            runId: result.runId,
            sessionId: result.sessionId,
            model: result.model,
            text: result.text,
            toolCallCount: result.toolCallCount,
            toolErrorCount: result.toolErrorCount,
            requestCount: result.requestCount,
            retainedWorktree: result.retainedWorktree,
            worktreePath: result.worktreePath,
            worktreeBranch: result.worktreeBranch,
          };
        });
        await this.notifySettled(options, completed);
        return completed;
      } catch (error) {
        const normalized = asError(error);
        const cancelled =
          normalized instanceof RunAbortedError || abortController.signal.aborted;
        const failed = await this.mutateTask(taskId, task => {
          if (isTerminalTask(task)) {
            return task;
          }
          return {
            ...task,
            status: cancelled ? 'cancelled' : 'failed',
            updatedAt: nowIso(),
            completedAt: nowIso(),
            error: normalized.message,
          };
        });
        await this.notifySettled(options, failed);
        return failed;
      }
    } finally {
      stopHeartbeat();
      this.abortControllers.delete(taskId);
      this.taskPromises.delete(taskId);
      ACTIVE_BACKGROUND_TASK_OWNERS.get(this.instanceId)?.delete(taskId);
    }
  }

  private async notifySettled(
    options: LaunchHadamardBackgroundTaskOptions,
    task: HadamardBackgroundTaskRecord,
  ): Promise<void> {
    try {
      await options.onSettled?.(task);
    } catch (error) {
      console.warn(
        `[BackgroundTask] Settlement observer failed for ${task.id}: ${asError(error).message}`,
      );
    }
  }

  private startOwnerHeartbeat(taskId: string): () => void {
    const timer = setInterval(() => {
      void this.store.mutate(taskId, current => {
        if (
          isTerminalTask(current) ||
          current.ownerPid !== process.pid ||
          current.ownerInstanceId !== this.instanceId
        ) {
          return current;
        }
        return {
          ...current,
          ownerHeartbeatAt: nowIso(),
        };
      }).catch(() => undefined);
    }, OWNER_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async mutateTask(
    taskId: string,
    updater: (task: HadamardBackgroundTaskRecord) => HadamardBackgroundTaskRecord,
  ): Promise<HadamardBackgroundTaskRecord> {
    const task = await this.store.mutate(taskId, updater);
    if (!task) {
      throw new Error(`No background task with id "${taskId}" exists.`);
    }
    return task;
  }
}
