import { randomUUID } from 'node:crypto';

import { createChildTraceContext, createRootTraceContext } from '../events/index.js';
import type { RuntimeServices } from '../runtime-v2/services.js';
import type {
  BudgetController,
  BudgetLimits,
  BudgetSnapshot,
  ConcurrencyController,
  ConcurrencyRunOptions,
  OrchestrationScope,
  PersistedScope,
  SecurityPolicyRef,
  TenantSessionNamespace,
  WorkspacePolicy,
} from './contracts.js';

const UNBOUNDED_INTEGER = Number.MAX_SAFE_INTEGER;
const UNBOUNDED_NUMBER = Number.MAX_VALUE;

export class SharedBudgetController implements BudgetController {
  private childRunsStarted = 0;
  private totalTokensUsed = 0;
  private costUsdUsed = 0;
  private readonly limits: Required<BudgetLimits>;

  constructor(limits: BudgetLimits = {}, initial?: Omit<BudgetSnapshot, 'limits'>) {
    this.limits = Object.freeze({
      maxChildRuns: validateIntegerLimit(
        limits.maxChildRuns ?? UNBOUNDED_INTEGER,
        'maxChildRuns',
      ),
      maxDepth: validateIntegerLimit(limits.maxDepth ?? UNBOUNDED_INTEGER, 'maxDepth'),
      maxTotalTokens: validateIntegerLimit(
        limits.maxTotalTokens ?? UNBOUNDED_INTEGER,
        'maxTotalTokens',
      ),
      maxCostUsd: validateNumberLimit(limits.maxCostUsd ?? UNBOUNDED_NUMBER, 'maxCostUsd'),
    });
    if (initial) {
      this.childRunsStarted = initial.childRunsStarted;
      this.totalTokensUsed = initial.totalTokensUsed;
      this.costUsdUsed = initial.costUsdUsed;
      this.assertInitialCounters();
    }
  }

  static fromSnapshot(snapshot: BudgetSnapshot): SharedBudgetController {
    return new SharedBudgetController(snapshot.limits, {
      childRunsStarted: snapshot.childRunsStarted,
      totalTokensUsed: snapshot.totalTokensUsed,
      costUsdUsed: snapshot.costUsdUsed,
    });
  }

  claimChild(depth: number): void {
    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new RangeError('Child depth must be a positive safe integer.');
    }
    if (depth > this.limits.maxDepth) {
      throw new Error(`Child depth ${depth} exceeds budget maxDepth ${this.limits.maxDepth}.`);
    }
    if (this.childRunsStarted >= this.limits.maxChildRuns) {
      throw new Error(`Child run budget ${this.limits.maxChildRuns} is exhausted.`);
    }
    this.childRunsStarted += 1;
  }

  recordUsage(usage: { readonly totalTokens: number; readonly costUsd: number }): void {
    const tokens = this.totalTokensUsed + usage.totalTokens;
    const cost = this.costUsdUsed + usage.costUsd;
    if (tokens > this.limits.maxTotalTokens) {
      throw new Error(`Child token budget ${this.limits.maxTotalTokens} is exceeded.`);
    }
    if (cost > this.limits.maxCostUsd) {
      throw new Error(`Child cost budget ${this.limits.maxCostUsd} is exceeded.`);
    }
    this.totalTokensUsed = tokens;
    this.costUsdUsed = cost;
  }

  snapshot(): BudgetSnapshot {
    return Object.freeze({
      limits: this.limits,
      childRunsStarted: this.childRunsStarted,
      totalTokensUsed: this.totalTokensUsed,
      costUsdUsed: this.costUsdUsed,
    });
  }

  private assertInitialCounters(): void {
    if (
      !Number.isSafeInteger(this.childRunsStarted)
      || this.childRunsStarted < 0
      || !Number.isSafeInteger(this.totalTokensUsed)
      || this.totalTokensUsed < 0
      || !Number.isFinite(this.costUsdUsed)
      || this.costUsdUsed < 0
    ) {
      throw new TypeError('Persisted budget counters are invalid.');
    }
  }
}

interface SemaphoreWaiter {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
}

/** Fair FIFO semaphore shared by all descendants. */
export class SemaphoreConcurrencyController implements ConcurrencyController {
  private readonly waiters: SemaphoreWaiter[] = [];
  private activeCount = 0;
  private peakCount = 0;

  constructor(readonly capacity = 8) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Concurrency capacity must be a positive safe integer.');
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get pending(): number {
    return this.waiters.length;
  }

  get peak(): number {
    return this.peakCount;
  }

  async run<T>(operation: () => Promise<T>, options: ConcurrencyRunOptions): Promise<T> {
    await this.acquire(options.signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.activeCount < this.capacity && this.waiters.length === 0) {
      this.activeCount += 1;
      this.peakCount = Math.max(this.peakCount, this.activeCount);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.activeCount -= 1;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.activeCount += 1;
      this.peakCount = Math.max(this.peakCount, this.activeCount);
      waiter.resolve();
      break;
    }
  }
}

export interface RootScopeOptions {
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly securityPolicy?: SecurityPolicyRef;
  readonly tenantSession?: TenantSessionNamespace;
  readonly workspacePolicy?: WorkspacePolicy;
  readonly budget?: BudgetController;
  readonly concurrency?: ConcurrencyController;
  readonly services: RuntimeServices;
  readonly metadata?: OrchestrationScope['metadata'];
}

interface RunTreeNode {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly controller: AbortController;
  readonly disposeBoundary: () => void;
  readonly children: Set<string>;
  completed: boolean;
}

/** Owns cancellation boundaries for a run tree without owning an AgentRuntime. */
export class RunTreeController {
  private readonly nodes = new Map<string, RunTreeNode>();

  createRoot(options: RootScopeOptions): OrchestrationScope {
    const runId = options.runId ?? randomUUID();
    if (this.nodes.has(runId)) throw new Error(`Run tree already contains "${runId}".`);
    // Validate and freeze the complete public scope before mutating the tree.
    // A rejected root must not leave an unreachable cancellation node behind.
    const securityPolicy = freezePolicy(options.securityPolicy ?? { id: 'default' });
    const tenantSession = freezeTenant(options.tenantSession ?? {
      tenantId: 'default',
      namespace: 'default',
    });
    const workspacePolicy = freezeWorkspace(options.workspacePolicy ?? { access: 'read-write' });
    const budget = options.budget ?? new SharedBudgetController();
    const concurrency = options.concurrency ?? new SemaphoreConcurrencyController();
    const metadata = Object.freeze({ ...(options.metadata ?? {}) });
    const boundary = createBoundary(options.signal, options.deadline);
    this.nodes.set(runId, {
      runId,
      controller: boundary.controller,
      disposeBoundary: boundary.dispose,
      children: new Set(),
      completed: false,
    });
    return Object.freeze({
      runId,
      depth: 0,
      trace: createRootTraceContext(runId),
      signal: boundary.controller.signal,
      deadline: options.deadline,
      securityPolicy,
      tenantSession,
      workspacePolicy,
      budget,
      concurrency,
      services: options.services,
      metadata,
    });
  }

  /** Adopt a run context created by a host runtime before deriving children. */
  adopt(scope: OrchestrationScope): void {
    if (this.nodes.has(scope.runId)) return;
    const boundary = createBoundary(scope.signal, scope.deadline);
    this.nodes.set(scope.runId, {
      runId: scope.runId,
      parentRunId: scope.parentRunId,
      controller: boundary.controller,
      disposeBoundary: boundary.dispose,
      children: new Set(),
      completed: false,
    });
  }

  deriveChild(parent: OrchestrationScope, childRunId: string = randomUUID()): OrchestrationScope {
    this.adopt(parent);
    if (this.nodes.has(childRunId)) {
      throw new Error(`Run tree already contains child "${childRunId}".`);
    }
    const parentNode = this.nodes.get(parent.runId)!;
    const boundary = createBoundary(parentNode.controller.signal, parent.deadline);
    const node: RunTreeNode = {
      runId: childRunId,
      parentRunId: parent.runId,
      controller: boundary.controller,
      disposeBoundary: boundary.dispose,
      children: new Set(),
      completed: false,
    };
    this.nodes.set(childRunId, node);
    parentNode.children.add(childRunId);

    return Object.freeze({
      runId: childRunId,
      parentRunId: parent.runId,
      depth: parent.depth + 1,
      trace: createChildTraceContext(childRunId, parent.runId, parent.trace),
      signal: boundary.controller.signal,
      deadline: parent.deadline,
      securityPolicy: parent.securityPolicy,
      tenantSession: parent.tenantSession,
      workspacePolicy: parent.workspacePolicy,
      budget: parent.budget,
      concurrency: parent.concurrency,
      services: parent.services,
      metadata: parent.metadata,
    });
  }

  cancelTree(runId: string, reason: unknown = new Error(`Run tree "${runId}" cancelled.`)): void {
    const root = this.nodes.get(runId);
    if (!root) return;
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (!node.controller.signal.aborted) node.controller.abort(reason);
      for (const childId of node.children) {
        const child = this.nodes.get(childId);
        if (child) pending.push(child);
      }
    }
  }

  complete(runId: string): void {
    const node = this.nodes.get(runId);
    if (!node) return;
    node.completed = true;
    this.prune(runId);
  }

  inspect(): ReadonlyArray<{
    runId: string;
    parentRunId?: string;
    childRunIds: readonly string[];
    aborted: boolean;
    completed: boolean;
  }> {
    return [...this.nodes.values()]
      .sort((left, right) => left.runId.localeCompare(right.runId))
      .map(node => ({
        runId: node.runId,
        parentRunId: node.parentRunId,
        childRunIds: [...node.children].sort(),
        aborted: node.controller.signal.aborted,
        completed: node.completed,
      }));
  }

  private prune(runId: string): void {
    const node = this.nodes.get(runId);
    if (!node?.completed || node.children.size > 0) return;
    node.disposeBoundary();
    this.nodes.delete(runId);
    if (!node.parentRunId) return;
    const parent = this.nodes.get(node.parentRunId);
    parent?.children.delete(runId);
    if (parent?.completed) this.prune(parent.runId);
  }
}

export function persistScope(scope: OrchestrationScope): PersistedScope {
  return {
    runId: scope.runId,
    parentRunId: scope.parentRunId,
    depth: scope.depth,
    trace: { ...scope.trace },
    deadline: scope.deadline,
    securityPolicy: freezePolicy(scope.securityPolicy),
    tenantSession: freezeTenant(scope.tenantSession),
    workspacePolicy: freezeWorkspace(scope.workspacePolicy),
    budget: scope.budget.snapshot(),
    metadata: { ...scope.metadata },
  };
}

export interface RestoreScopeOptions {
  readonly services: RuntimeServices;
  readonly signal?: AbortSignal;
  readonly concurrency?: ConcurrencyController;
}

export function restoreScope(
  persisted: PersistedScope,
  options: RestoreScopeOptions,
): OrchestrationScope {
  return Object.freeze({
    runId: persisted.runId,
    parentRunId: persisted.parentRunId,
    depth: persisted.depth,
    trace: { ...persisted.trace },
    signal: options.signal ?? new AbortController().signal,
    deadline: persisted.deadline,
    securityPolicy: freezePolicy(persisted.securityPolicy),
    tenantSession: freezeTenant(persisted.tenantSession),
    workspacePolicy: freezeWorkspace(persisted.workspacePolicy),
    budget: SharedBudgetController.fromSnapshot(persisted.budget),
    concurrency: options.concurrency ?? new SemaphoreConcurrencyController(),
    services: options.services,
    metadata: Object.freeze({ ...persisted.metadata }),
  });
}

interface AbortBoundary {
  readonly controller: AbortController;
  readonly dispose: () => void;
}

function createBoundary(parent: AbortSignal | undefined, deadline: number | undefined): AbortBoundary {
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline < 0)) {
    throw new RangeError('Orchestration deadline must be a finite Unix epoch value.');
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!controller.signal.aborted && deadline !== undefined) {
    timer = setTimeout(() => {
      controller.abort(new Error('Orchestration deadline exceeded.'));
    }, Math.max(0, deadline - Date.now()));
    timer.unref?.();
  }
  return {
    controller,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function validateIntegerLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function validateNumberLimit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number.`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Operation aborted.');
}

function freezePolicy(policy: SecurityPolicyRef): SecurityPolicyRef {
  if (!policy.id.trim()) throw new Error('Security policy id must not be empty.');
  return Object.freeze({
    ...policy,
    attributes: policy.attributes ? Object.freeze({ ...policy.attributes }) : undefined,
  });
}

function freezeTenant(namespace: TenantSessionNamespace): TenantSessionNamespace {
  if (!namespace.tenantId.trim() || !namespace.namespace.trim()) {
    throw new Error('Tenant id and session namespace must not be empty.');
  }
  return Object.freeze({ ...namespace });
}

function freezeWorkspace(policy: WorkspacePolicy): WorkspacePolicy {
  return Object.freeze({
    ...policy,
    allowedRoots: policy.allowedRoots ? Object.freeze([...policy.allowedRoots]) : undefined,
  });
}
