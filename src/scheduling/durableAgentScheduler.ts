import type { AgentSpec, JsonValue } from '../core/index.js';
import type {
  DurableChildHandle,
  DurableChildRecord,
  DurableFailurePolicy,
  SpawnBackgroundRequest,
} from '../orchestration/background.js';
import type { OrchestrationInput, OrchestrationScope } from '../orchestration/contracts.js';
import type {
  CronSchedule,
  ScheduledTaskContext,
  ScheduledTaskRecord,
  ScheduledTaskStore,
} from '../types.js';
import { TaskScheduler } from './scheduler.js';

export interface DurableBackgroundSpawner {
  spawn(request: SpawnBackgroundRequest): Promise<DurableChildHandle>;
  handle(childId: string): DurableChildHandle;
  query(childId: string): Promise<DurableChildRecord>;
}

export interface DurableScheduledAgentTask {
  readonly id: string;
  readonly schedule: CronSchedule;
  readonly agent: AgentSpec<JsonValue | undefined, JsonValue>;
  readonly input: OrchestrationInput | ((context: ScheduledTaskContext) => OrchestrationInput);
  readonly parent: OrchestrationScope | ((context: ScheduledTaskContext) => OrchestrationScope);
  readonly context?: JsonValue | ((context: ScheduledTaskContext) => JsonValue | undefined);
  readonly description?: string;
  readonly enabled?: boolean;
  readonly effect?: DurableChildRecord['effect'];
  readonly idempotencyKey?: string | ((context: ScheduledTaskContext) => string | undefined);
  readonly failurePolicy?: DurableFailurePolicy;
  /** Defaults to true. False leaves a durable queued child for a worker process. */
  readonly autoStart?: boolean;
  /** Defaults to false; scheduling success normally means the durable record was committed. */
  readonly waitForResult?: boolean;
}

export interface DurableAgentSchedulerOptions {
  readonly manager: DurableBackgroundSpawner;
  readonly store?: ScheduledTaskStore;
}

/** Bridges cron scheduling to durable spawn without scheduler-level run replay. */
export class DurableAgentScheduler {
  private readonly scheduler: TaskScheduler;
  private readonly manager: DurableBackgroundSpawner;

  constructor(options: DurableAgentSchedulerOptions) {
    this.manager = options.manager;
    this.scheduler = new TaskScheduler({ store: options.store, defaultMaxRetries: 0 });
  }

  schedule(definition: DurableScheduledAgentTask): Promise<ScheduledTaskRecord> {
    validateDefinition(definition);
    return this.scheduler.schedule({
      id: definition.id,
      schedule: definition.schedule,
      description: definition.description,
      enabled: definition.enabled,
      // A scheduler retry could replay spawn after a lost response. Durable child
      // identity and ChildRunner failure policy own retry semantics instead.
      maxRetries: 0,
      task: context => this.spawnInvocation(definition, context),
    });
  }

  start(): void { this.scheduler.start(); }
  stop(): void { this.scheduler.stop(); }
  dispose(): Promise<void> { return this.scheduler.dispose(); }
  trigger(id: string): Promise<void> { return this.scheduler.trigger(id); }
  remove(id: string): Promise<void> { return this.scheduler.remove(id); }
  get(id: string): Promise<ScheduledTaskRecord | undefined> { return this.scheduler.get(id); }
  list(): Promise<ScheduledTaskRecord[]> { return this.scheduler.list(); }

  private async spawnInvocation(
    definition: DurableScheduledAgentTask,
    context: ScheduledTaskContext,
  ): Promise<{ childId: string; status: string }> {
    const childId = scheduledChildId(context);
    const existing = await this.manager.query(childId).catch(error => {
      if (error instanceof Error && /Unknown durable child/.test(error.message)) return undefined;
      throw error;
    });
    let handle: DurableChildHandle;
    if (existing) {
      handle = this.manager.handle(childId);
    } else {
      try {
        handle = await this.manager.spawn({
          parent: resolveValue(definition.parent, context),
          agent: definition.agent,
          input: resolveValue(definition.input, context),
          context: resolveOptionalValue(definition.context, context),
          childId,
          effect: definition.effect,
          idempotencyKey: resolveOptionalValue(definition.idempotencyKey, context),
          failurePolicy: definition.failurePolicy,
          autoStart: definition.autoStart,
          metadata: {
            schedulerTaskId: context.taskId,
            scheduledAt: context.scheduledAt,
            invocationCount: context.invocationCount,
          },
        });
      } catch (error) {
        // Handles the cross-process query/create race without creating another id.
        const raced = await this.manager.query(childId).catch(() => undefined);
        if (!raced) throw error;
        handle = this.manager.handle(childId);
      }
    }
    if (definition.waitForResult) await handle.result();
    const record = await handle.query();
    return { childId, status: record.status };
  }
}

function scheduledChildId(context: ScheduledTaskContext): string {
  return `scheduled:${encodeURIComponent(context.taskId)}:${encodeURIComponent(context.scheduledAt)}:${context.invocationCount}`;
}

function resolveValue<T>(value: T | ((context: ScheduledTaskContext) => T), context: ScheduledTaskContext): T {
  return typeof value === 'function'
    ? (value as (context: ScheduledTaskContext) => T)(context)
    : value;
}

function resolveOptionalValue<T>(
  value: T | ((context: ScheduledTaskContext) => T | undefined) | undefined,
  context: ScheduledTaskContext,
): T | undefined {
  return value === undefined ? undefined : resolveValue(value, context);
}

function validateDefinition(definition: DurableScheduledAgentTask): void {
  if (!definition.id.trim()) throw new TypeError('Scheduled agent task id must not be empty.');
  if (definition.failurePolicy?.mode === 'retry-safe') {
    if (definition.effect === 'side-effect' || definition.effect === undefined) {
      throw new Error('retry-safe scheduled children must be read or idempotent-write.');
    }
    if (definition.effect === 'idempotent-write' && definition.idempotencyKey === undefined) {
      throw new Error('retry-safe idempotent-write scheduled children require an idempotencyKey.');
    }
  }
}
