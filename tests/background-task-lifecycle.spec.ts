import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActoviqBackgroundTaskManager } from '../src/runtime/actoviqBackgroundTasks.js';
import { BackgroundTaskStore } from '../src/storage/backgroundTaskStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createManager(): Promise<{
  manager: ActoviqBackgroundTaskManager;
  store: BackgroundTaskStore;
  workDir: string;
}> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-background-lifecycle-'));
  tempDirs.push(workDir);
  const store = new BackgroundTaskStore(path.join(workDir, 'state'));
  return {
    manager: new ActoviqBackgroundTaskManager(store),
    store,
    workDir,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ActoviqBackgroundTaskManager lifecycle', () => {
  it('keeps a successful task completed when its settlement observer throws', async () => {
    const { manager, store, workDir } = await createManager();
    const onSettled = vi.fn(async () => {
      throw new Error('observer failed');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Complete despite observer failure',
      workDir,
      async onRun() {
        return {
          runId: 'run-success',
          sessionId: 'session-success',
          model: 'test-model',
          text: 'finished',
          toolCallCount: 1,
        };
      },
      onSettled,
    });

    const settled = await manager.wait(launched.id);

    expect(settled).toMatchObject({
      status: 'completed',
      runId: 'run-success',
      sessionId: 'session-success',
      text: 'finished',
    });
    await expect(store.load(launched.id)).resolves.toMatchObject({
      status: 'completed',
      runId: 'run-success',
      text: 'finished',
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('observer failed'));
  });

  it('keeps cancellation terminal when onRun ignores AbortSignal and returns successfully', async () => {
    const { manager, store, workDir } = await createManager();
    const started = deferred();
    const aborted = deferred();
    const finishRun = deferred();
    const onSettled = vi.fn();

    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Ignore cancellation while finishing',
      workDir,
      async onRun(signal) {
        signal.addEventListener('abort', aborted.resolve, { once: true });
        started.resolve();
        await finishRun.promise;
        return {
          runId: 'run-after-cancel',
          sessionId: 'session-after-cancel',
          model: 'test-model',
          text: 'late success',
          toolCallCount: 0,
        };
      },
      onSettled,
    });

    await started.promise;
    const cancelling = manager.cancel(launched.id);
    await aborted.promise;
    finishRun.resolve();

    const [cancelResult, settled] = await Promise.all([
      cancelling,
      manager.wait(launched.id),
    ]);

    expect(cancelResult?.status).toBe('cancelled');
    expect(settled.status).toBe('cancelled');
    expect(settled.error).toBe('Cancelled.');
    expect(settled.runId).toBeUndefined();
    await expect(store.load(launched.id)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'Cancelled.',
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  it('does not revive an early cancellation when the queued-to-running mutation is delayed', async () => {
    const { manager, store, workDir } = await createManager();
    const startLoadCaptured = deferred();
    const releaseStartLoad = deferred();
    const cancelMutationQueued = deferred();
    const originalLoad = store.load.bind(store);
    const originalMutate = store.mutate.bind(store);
    let loadCount = 0;
    let mutationCount = 0;

    vi.spyOn(store, 'load').mockImplementation(async (taskId) => {
      const task = await originalLoad(taskId);
      loadCount += 1;
      if (loadCount === 2) {
        startLoadCaptured.resolve();
        await releaseStartLoad.promise;
      }
      return task;
    });
    vi.spyOn(store, 'mutate').mockImplementation((taskId, updater) => {
      mutationCount += 1;
      if (mutationCount === 3) {
        cancelMutationQueued.resolve();
      }
      return originalMutate(taskId, updater);
    });

    const onRun = vi.fn(async () => ({
      runId: 'run-should-not-start',
      model: 'test-model',
      text: 'unexpected',
      toolCallCount: 0,
    }));
    const onSettled = vi.fn();
    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Cancel before running is persisted',
      workDir,
      onRun,
      onSettled,
    });

    await startLoadCaptured.promise;
    const cancelling = manager.cancel(launched.id);
    await cancelMutationQueued.promise;
    releaseStartLoad.resolve();

    const [cancelled, settled] = await Promise.all([
      cancelling,
      manager.wait(launched.id),
    ]);

    expect(cancelled?.status).toBe('cancelled');
    expect(settled.status).toBe('cancelled');
    expect(onRun).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    await expect(originalLoad(launched.id)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'Cancelled.',
    });
  });

  it('cleans live ownership when the initial queued-to-running mutation fails', async () => {
    const { manager, store, workDir } = await createManager();
    const transitionStarted = deferred();
    const releaseTransition = deferred();
    const originalMutate = store.mutate.bind(store);
    let mutationCount = 0;
    vi.spyOn(store, 'mutate').mockImplementation(async (taskId, updater) => {
      mutationCount += 1;
      if (mutationCount === 2) {
        transitionStarted.resolve();
        await releaseTransition.promise;
        throw new Error('initial transition failed');
      }
      return originalMutate(taskId, updater);
    });
    const onRun = vi.fn(async () => ({
      runId: 'run-should-not-start',
      model: 'test-model',
      text: 'unexpected',
      toolCallCount: 0,
    }));
    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Fail before the worker starts',
      workDir,
      onRun,
    });

    await transitionStarted.promise;
    const waiting = manager.wait(launched.id);
    releaseTransition.resolve();
    await expect(waiting).rejects.toThrow('initial transition failed');
    expect(onRun).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
      expect.objectContaining({
        id: launched.id,
        status: 'failed',
      }),
    ]);
    await manager.cancelAll();
  });

  it('serializes progress and cancellation across store instances without reviving the task', async () => {
    const { manager, store, workDir } = await createManager();
    const allowProgress = deferred();
    const progressLoadCaptured = deferred();
    const releaseProgressLoad = deferred();
    const progressSaved = deferred();
    const finishRun = deferred();
    const runStarted = deferred();
    const onSettled = vi.fn();

    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Cancel during a progress write',
      workDir,
      async onRun(_signal, updateProgress) {
        runStarted.resolve();
        await allowProgress.promise;
        await updateProgress({
          partialText: 'progress captured before cancellation',
          progressSummary: 'working',
        });
        progressSaved.resolve();
        await finishRun.promise;
        return {
          runId: 'run-after-progress-race',
          model: 'test-model',
          text: 'late success',
          toolCallCount: 0,
        };
      },
      onSettled,
    });

    await runStarted.promise;
    const originalLoad = store.load.bind(store);
    let shouldBlockProgressLoad = true;
    vi.spyOn(store, 'load').mockImplementation(async (taskId) => {
      const task = await originalLoad(taskId);
      if (shouldBlockProgressLoad) {
        shouldBlockProgressLoad = false;
        progressLoadCaptured.resolve();
        await releaseProgressLoad.promise;
      }
      return task;
    });

    allowProgress.resolve();
    await progressLoadCaptured.promise;

    const cancellingStore = new BackgroundTaskStore(path.join(workDir, 'state'));
    const cancellingManager = new ActoviqBackgroundTaskManager(cancellingStore);
    const cancelMutationStarted = deferred();
    const originalCancelMutate = cancellingStore.mutate.bind(cancellingStore);
    vi.spyOn(cancellingStore, 'mutate').mockImplementation((taskId, updater) => {
      cancelMutationStarted.resolve();
      return originalCancelMutate(taskId, updater);
    });
    const cancelling = cancellingManager.cancel(launched.id);
    await cancelMutationStarted.promise;
    releaseProgressLoad.resolve();

    const [cancelled] = await Promise.all([cancelling, progressSaved.promise]);
    expect(cancelled?.status).toBe('cancelled');
    await expect(cancellingStore.load(launched.id)).resolves.toMatchObject({
      status: 'cancelled',
      partialText: 'progress captured before cancellation',
    });

    finishRun.resolve();
    const settled = await manager.wait(launched.id);
    expect(settled.status).toBe('cancelled');
    expect(settled.runId).toBeUndefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
    await expect(cancellingStore.load(launched.id)).resolves.toMatchObject({
      status: 'cancelled',
      partialText: 'progress captured before cancellation',
    });
  });

  it('persists and deduplicates queued inputs across manager instances', async () => {
    const { manager, store, workDir } = await createManager();
    const started = deferred();
    const finishRun = deferred();
    const secondManager = new ActoviqBackgroundTaskManager(
      new BackgroundTaskStore(path.join(workDir, 'state')),
    );
    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Accept durable follow-up input',
      workDir,
      async onRun() {
        started.resolve();
        await finishRun.promise;
        return {
          runId: 'run-durable-input',
          model: 'test-model',
          text: 'finished',
          toolCallCount: 0,
        };
      },
    });

    try {
      await started.promise;
      const input = {
        id: 'toolu_durable_input',
        text: 'Inspect the cross-client path.',
        rootExecutionId: 'root-durable-input',
        edgeCallId: 'toolu_durable_input',
      };
      await expect(secondManager.reserveInput(launched.id, input)).resolves.toMatchObject({
        accepted: true,
        queued: true,
      });
      await expect(manager.reserveInput(launched.id, input)).resolves.toMatchObject({
        accepted: false,
        queued: false,
      });
      await expect(store.load(launched.id)).resolves.toMatchObject({
        queuedMessageCount: 1,
        queuedInputs: [input],
        seenInputIds: ['toolu_durable_input'],
      });
      await expect(manager.drainInputs(launched.id)).resolves.toEqual([input]);
      await expect(secondManager.drainInputs(launched.id)).resolves.toEqual([]);
      await expect(store.load(launched.id)).resolves.toMatchObject({
        queuedMessageCount: 0,
        queuedInputs: [],
        seenInputIds: ['toolu_durable_input'],
      });
    } finally {
      finishRun.resolve();
      await manager.wait(launched.id);
      await secondManager.cancelAll();
      await manager.cancelAll();
    }
  });

  it('does not reconcile a task whose owner process is still alive', async () => {
    const { manager, store, workDir } = await createManager();
    const runStarted = deferred();
    const finishRun = deferred();
    const launched = await manager.launch({
      subagentType: 'test-agent',
      description: 'Remain active during another manager startup',
      workDir,
      async onRun() {
        runStarted.resolve();
        await finishRun.promise;
        return {
          runId: 'run-live-owner',
          model: 'test-model',
          text: 'finished after reconciliation check',
          toolCallCount: 0,
        };
      },
    });
    await runStarted.promise;

    const secondManager = new ActoviqBackgroundTaskManager(
      new BackgroundTaskStore(path.join(workDir, 'state')),
    );
    await expect(secondManager.reconcileInterruptedTasks()).resolves.toEqual([]);
    await expect(store.load(launched.id)).resolves.toMatchObject({
      status: 'running',
      ownerPid: process.pid,
      ownerInstanceId: expect.any(String),
    });

    finishRun.resolve();
    await expect(manager.wait(launched.id)).resolves.toMatchObject({
      status: 'completed',
      runId: 'run-live-owner',
    });
  });

  it('reconciles a same-process task whose owner instance is not registered', async () => {
    const { manager, store, workDir } = await createManager();
    const createdAt = new Date().toISOString();
    const task = await store.create({
      status: 'running',
      ownerPid: process.pid,
      ownerInstanceId: 'orphaned-manager-instance',
      ownerHeartbeatAt: createdAt,
      description: 'Recover an orphaned same-process owner',
      subagentType: 'test-agent',
      outputFile: '',
      workDir,
      createdAt,
      updatedAt: createdAt,
    });

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'failed',
      }),
    ]);
    await manager.cancelAll();
  });

  it('uses a live process heartbeat lease and recovers stale or exited owners', async () => {
    const { manager, store, workDir } = await createManager();
    const child = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );

    try {
      await once(child.stdout!, 'data');
      if (!child.pid) {
        throw new Error('The owner test process did not expose a pid.');
      }
      const createdAt = new Date().toISOString();
      const liveTask = await store.create({
        status: 'running',
        ownerPid: child.pid,
        ownerInstanceId: 'live-child-owner',
        ownerHeartbeatAt: createdAt,
        description: 'Keep a live owner',
        subagentType: 'test-agent',
        outputFile: '',
        workDir,
        createdAt,
        updatedAt: createdAt,
      });
      const staleTask = await store.create({
        status: 'running',
        ownerPid: child.pid,
        ownerInstanceId: 'reused-child-owner',
        ownerHeartbeatAt: '2000-01-01T00:00:00.000Z',
        description: 'Recover a stale owner lease',
        subagentType: 'test-agent',
        outputFile: '',
        workDir,
        createdAt,
        updatedAt: createdAt,
      });

      await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
        expect.objectContaining({
          id: staleTask.id,
          status: 'failed',
        }),
      ]);
      await expect(store.load(liveTask.id)).resolves.toMatchObject({
        status: 'running',
      });

      const childExited = once(child, 'exit');
      child.kill();
      await childExited;
      await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
        expect.objectContaining({
          id: liveTask.id,
          status: 'failed',
        }),
      ]);
    } finally {
      if (!child.killed && child.exitCode === null) {
        const childExited = once(child, 'exit');
        child.kill();
        await childExited.catch(() => undefined);
      }
      await manager.cancelAll();
    }
  });

  it('reconciles a task whose persisted owner process is gone', async () => {
    const { manager, store, workDir } = await createManager();
    const createdAt = new Date().toISOString();
    const task = await store.create({
      status: 'running',
      ownerPid: 2_147_483_647,
      ownerInstanceId: 'dead-owner',
      description: 'Recover a dead owner',
      subagentType: 'test-agent',
      outputFile: '',
      workDir,
      createdAt,
      updatedAt: createdAt,
    });

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'failed',
        error: expect.stringContaining('interrupted by a runtime restart'),
      }),
    ]);
    await expect(store.load(task.id)).resolves.toMatchObject({
      status: 'failed',
      ownerPid: 2_147_483_647,
    });
  });
});
