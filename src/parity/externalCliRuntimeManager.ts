import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createActoviqBridgeSdk } from './actoviqBridgeSdk.js';
import type {
  ActoviqBridgeJsonEvent,
  ActoviqBridgeRunOptions,
  ActoviqBridgeRunResult,
  ActoviqBridgeSessionCreateOptions,
  CreateActoviqBridgeSdkOptions,
} from '../types.js';

export type ExternalCliRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface ExternalCliRunStreamLike extends AsyncIterable<ActoviqBridgeJsonEvent> {
  readonly result: Promise<ActoviqBridgeRunResult>;
}

export interface ExternalCliSessionLike {
  readonly id: string;
  stream(
    prompt: string,
    options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>,
  ): ExternalCliRunStreamLike;
}

export interface ExternalCliClientLike {
  createSession(options?: ActoviqBridgeSessionCreateOptions): Promise<ExternalCliSessionLike>;
  resumeSession(
    sessionId: string,
    options?: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'>,
  ): Promise<ExternalCliSessionLike>;
  close(): Promise<void>;
}

export type ExternalCliClientFactory = (
  options: CreateActoviqBridgeSdkOptions,
) => Promise<ExternalCliClientLike>;

export interface ExternalCliRuntimeManagerOptions {
  clientFactory?: ExternalCliClientFactory;
  /** Soft total run limit. Queued and running records are never evicted. */
  maxRetainedRuns?: number;
  eventCapacity?: number;
  logCapacity?: number;
  maxEventBytes?: number;
  maxEventBufferBytes?: number;
  maxLogBytes?: number;
  maxLogBufferBytes?: number;
  now?: () => string;
  runIdFactory?: () => string;
}

export interface ExternalCliRunStartOptions {
  actoviqSessionId: string;
  configId: string;
  cwd: string;
  prompt: string;
  nativeSessionId?: string;
  background?: boolean;
  /** Child-only authentication/configuration override. It is never retained by the manager. */
  env?: Record<string, string>;
  clientOptions?: CreateActoviqBridgeSdkOptions;
  sessionOptions?: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'>;
  runOptions?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'signal'>;
}

export interface ExternalCliRunEvent {
  kind: 'event';
  sequence: number;
  timestamp: string;
  event: ActoviqBridgeJsonEvent;
}

export interface ExternalCliRunLog {
  kind: 'log';
  sequence: number;
  timestamp: string;
  level: 'info' | 'error';
  message: string;
}

export interface ExternalCliRunResultSnapshot {
  text: string;
  nativeSessionId: string;
  isError: boolean;
  subtype?: string;
  stopReason?: string;
  durationMs?: number;
  totalCostUsd?: number;
  numTurns?: number;
  exitCode: number | null;
  stderr: string;
}

export interface ExternalCliRunErrorSnapshot {
  name: string;
  message: string;
}

export interface ExternalCliRunSnapshot {
  runId: string;
  actoviqSessionId: string;
  configId: string;
  cwd: string;
  background: boolean;
  status: ExternalCliRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  nativeSessionId?: string;
  result?: ExternalCliRunResultSnapshot;
  error?: ExternalCliRunErrorSnapshot;
  events: ExternalCliRunEvent[];
  logs: ExternalCliRunLog[];
}

export type ExternalCliStoredUpdate = ExternalCliRunEvent | ExternalCliRunLog;

export type ExternalCliRunUpdate =
  | ExternalCliStoredUpdate
  | { kind: 'snapshot'; run: ExternalCliRunSnapshot }
  | { kind: 'status'; run: ExternalCliRunSnapshot };

export interface ExternalCliRunReplay {
  run: ExternalCliRunSnapshot;
  updates: ExternalCliStoredUpdate[];
}

interface CachedRuntime {
  client: ExternalCliClientLike;
  session: ExternalCliSessionLike;
}

interface RunRecord {
  runId: string;
  cacheKey: string;
  actoviqSessionId: string;
  configId: string;
  cwd: string;
  background: boolean;
  status: ExternalCliRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  nativeSessionId?: string;
  result?: ExternalCliRunResultSnapshot;
  error?: ExternalCliRunErrorSnapshot;
  events: ExternalCliRunEvent[];
  logs: ExternalCliRunLog[];
  nextSequence: number;
  controller: AbortController;
  task: Promise<void>;
  subscribers: Set<(update: ExternalCliRunUpdate) => void>;
}

const TERMINAL_STATUSES = new Set<ExternalCliRunStatus>([
  'completed',
  'failed',
  'aborted',
]);
const SECRET_KEY_PATTERN =
  /(?:api.?key|access.?key|private.?key|token|authorization|auth|password|secret|cookie|credential)/i;
const ENV_KEY_PATTERN = /^(?:env|environment|processEnv|environmentVariables)$/i;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENT_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LOG_BYTES = 16 * 1024;
const DEFAULT_MAX_LOG_BUFFER_BYTES = 128 * 1024;
const DEFAULT_MAX_RETAINED_RUNS = 128;

function positiveCapacity(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('Ring buffer capacity must be a positive integer.');
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function byteCapacity(
  value: number | undefined,
  fallback: number,
  minimum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum} bytes.`);
  }
  return value;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = ' [TRUNCATED]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const prefix = Buffer.from(value, 'utf8')
    .subarray(0, Math.max(0, maxBytes - markerBytes))
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return prefix + marker;
}

function truncateEvent(
  _event: ActoviqBridgeJsonEvent,
  originalBytes: number,
): ActoviqBridgeJsonEvent {
  return {
    type: 'truncated',
    truncated: true,
    original_bytes: originalBytes,
  };
}

function trimToByteCapacity<T>(entries: T[], maxBytes: number): void {
  while (entries.length > 0 && serializedBytes(entries) > maxBytes) entries.shift();
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    );
}

function sanitizeValue(
  value: unknown,
  secrets: readonly string[],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, secrets, seen));

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (ENV_KEY_PATTERN.test(key)) continue;
    sanitized[key] = SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeValue(child, secrets, seen);
  }
  return sanitized;
}

function collectSecrets(options: ExternalCliRunStartOptions): string[] {
  const values = new Set<string>();
  const addEnvironment = (environment: Record<string, string> | undefined) => {
    for (const value of Object.values(environment ?? {})) {
      if (value.length > 0) values.add(value);
    }
  };
  addEnvironment(options.env);
  addEnvironment(options.clientOptions?.env);
  addEnvironment(options.sessionOptions?.env);
  addEnvironment(options.runOptions?.env);
  if (options.clientOptions?.apiKey) values.add(options.clientOptions.apiKey);
  if (options.sessionOptions?.apiKey) values.add(options.sessionOptions.apiKey);
  if (options.runOptions?.apiKey) values.add(options.runOptions.apiKey);
  return [...values].sort((left, right) => right.length - left.length);
}

function sanitizeEvent(
  event: ActoviqBridgeJsonEvent,
  secrets: readonly string[],
): ActoviqBridgeJsonEvent {
  const sanitized = sanitizeValue(event, secrets);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return { type: 'unknown' };
  }
  const record = sanitized as Record<string, unknown>;
  return {
    ...record,
    type: typeof record.type === 'string' ? record.type : 'unknown',
  };
}

function sanitizeError(error: unknown, secrets: readonly string[]): ExternalCliRunErrorSnapshot {
  if (error instanceof Error) {
    return {
      name: redactString(error.name || 'Error', secrets),
      message: redactString(error.message || 'External CLI run failed.', secrets),
    };
  }
  return {
    name: 'Error',
    message: redactString(String(error), secrets),
  };
}

function isTerminal(status: ExternalCliRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function cacheKeyFor(actoviqSessionId: string, configId: string, cwd: string): string {
  return `${actoviqSessionId}\u0000${configId}\u0000${cwd}`;
}

function copyEvent(entry: ExternalCliRunEvent): ExternalCliRunEvent {
  return {
    ...entry,
    event: structuredClone(entry.event),
  };
}

function copyLog(entry: ExternalCliRunLog): ExternalCliRunLog {
  return { ...entry };
}

export class ExternalCliRuntimeManager {
  private readonly clientFactory: ExternalCliClientFactory;
  private readonly maxRetainedRuns: number;
  private readonly eventCapacity: number;
  private readonly logCapacity: number;
  private readonly maxEventBytes: number;
  private readonly maxEventBufferBytes: number;
  private readonly maxLogBytes: number;
  private readonly maxLogBufferBytes: number;
  private readonly now: () => string;
  private readonly runIdFactory: () => string;
  private readonly runtimes = new Map<string, CachedRuntime>();
  private readonly runtimePromises = new Map<string, Promise<CachedRuntime>>();
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly terminalRunIds = new Set<string>();
  private closed = false;

  constructor(options: ExternalCliRuntimeManagerOptions = {}) {
    this.clientFactory = options.clientFactory ?? (async sdkOptions => createActoviqBridgeSdk(sdkOptions));
    this.maxRetainedRuns = positiveInteger(
      options.maxRetainedRuns,
      DEFAULT_MAX_RETAINED_RUNS,
      'maxRetainedRuns',
    );
    this.eventCapacity = positiveCapacity(options.eventCapacity, 256);
    this.logCapacity = positiveCapacity(options.logCapacity, 128);
    this.maxEventBufferBytes = byteCapacity(
      options.maxEventBufferBytes,
      DEFAULT_MAX_EVENT_BUFFER_BYTES,
      512,
      'maxEventBufferBytes',
    );
    this.maxEventBytes = Math.min(
      byteCapacity(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 128, 'maxEventBytes'),
      this.maxEventBufferBytes,
    );
    this.maxLogBufferBytes = byteCapacity(
      options.maxLogBufferBytes,
      DEFAULT_MAX_LOG_BUFFER_BYTES,
      256,
      'maxLogBufferBytes',
    );
    this.maxLogBytes = Math.min(
      byteCapacity(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES, 16, 'maxLogBytes'),
      this.maxLogBufferBytes,
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.runIdFactory = options.runIdFactory ?? randomUUID;
  }

  async start(options: ExternalCliRunStartOptions): Promise<ExternalCliRunSnapshot> {
    const record = this.launch(options);
    if (!options.background) await record.task;
    return this.snapshot(record);
  }

  async *stream(options: ExternalCliRunStartOptions): AsyncIterable<ExternalCliRunUpdate> {
    const record = this.launch({ ...options, background: true });
    const queued: ExternalCliRunUpdate[] = [];
    let wake: (() => void) | undefined;
    const subscriber = (update: ExternalCliRunUpdate) => {
      queued.push(update);
      wake?.();
      wake = undefined;
    };
    record.subscribers.add(subscriber);

    try {
      yield { kind: 'snapshot', run: this.snapshot(record) };
      while (true) {
        while (queued.length > 0) {
          const update = queued.shift();
          if (update) yield update;
        }
        if (isTerminal(record.status)) break;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    } finally {
      record.subscribers.delete(subscriber);
    }
  }

  get(runId: string): ExternalCliRunSnapshot | undefined {
    const record = this.runs.get(runId);
    return record ? this.snapshot(record) : undefined;
  }

  list(): ExternalCliRunSnapshot[] {
    return [...this.runs.values()].map(record => this.snapshot(record));
  }

  replay(runId: string, afterSequence = 0): ExternalCliRunReplay | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    const updates: ExternalCliStoredUpdate[] = [
      ...record.events.map(copyEvent),
      ...record.logs.map(copyLog),
    ]
      .filter(update => update.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence);
    return { run: this.snapshot(record), updates };
  }

  async wait(runId: string): Promise<ExternalCliRunSnapshot | undefined> {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    await record.task;
    return this.snapshot(record);
  }

  abort(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record || isTerminal(record.status)) return false;
    record.controller.abort();
    this.pushLog(record, 'info', 'Run aborted.');
    this.transition(record, 'aborted');
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.runs.values()];
    for (const record of records) this.abort(record.runId);
    await Promise.allSettled(records.map(record => record.task));

    const clients = new Set([...this.runtimes.values()].map(runtime => runtime.client));
    await Promise.allSettled([...clients].map(client => client.close()));
    this.runtimes.clear();
    this.runtimePromises.clear();
    this.queueTails.clear();
    for (const record of records) record.subscribers.clear();
  }

  private launch(options: ExternalCliRunStartOptions): RunRecord {
    if (this.closed) throw new Error('External CLI runtime manager is closed.');
    if (!options.actoviqSessionId || !options.configId || !options.cwd) {
      throw new TypeError('actoviqSessionId, configId, and cwd are required.');
    }

    const cwd = path.resolve(options.cwd);
    const cacheKey = cacheKeyFor(options.actoviqSessionId, options.configId, cwd);
    const runId = this.runIdFactory();
    if (this.runs.has(runId)) throw new Error(`Duplicate external CLI run id: ${runId}`);

    const record: RunRecord = {
      runId,
      cacheKey,
      actoviqSessionId: options.actoviqSessionId,
      configId: options.configId,
      cwd,
      background: options.background === true,
      status: 'queued',
      createdAt: this.now(),
      nativeSessionId: options.nativeSessionId,
      events: [],
      logs: [],
      nextSequence: 1,
      controller: new AbortController(),
      task: Promise.resolve(),
      subscribers: new Set(),
    };
    this.runs.set(runId, record);
    this.pruneRetainedRuns();
    this.pushLog(record, 'info', 'Run queued.');

    const previous = this.queueTails.get(cacheKey) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.execute(record, options));
    record.task = task;
    const tail = task.finally(() => {
      if (this.queueTails.get(cacheKey) === tail) this.queueTails.delete(cacheKey);
    });
    this.queueTails.set(cacheKey, tail);
    return record;
  }

  private async execute(record: RunRecord, options: ExternalCliRunStartOptions): Promise<void> {
    if (record.controller.signal.aborted || isTerminal(record.status)) return;
    record.startedAt = this.now();
    this.transition(record, 'running');
    this.pushLog(record, 'info', 'Run started.');
    const secrets = collectSecrets(options);

    try {
      const runtime = await this.getRuntime(record, options);
      if (record.controller.signal.aborted || isTerminal(record.status)) return;

      if (options.nativeSessionId && runtime.session.id !== options.nativeSessionId) {
        runtime.session = await runtime.client.resumeSession(options.nativeSessionId, {
          ...options.sessionOptions,
          directCli: true,
          workDir: record.cwd,
        });
      }
      const runStream = runtime.session.stream(options.prompt, {
        ...options.runOptions,
        directCli: true,
        workDir: record.cwd,
        signal: record.controller.signal,
      });
      const resultPromise = runStream.result;
      void resultPromise.catch(() => undefined);
      for await (const event of runStream) {
        const sanitizedEvent = sanitizeEvent(event, secrets);
        const discoveredSessionId =
          sanitizedEvent.type === 'system' &&
          sanitizedEvent.subtype === 'init' &&
          typeof sanitizedEvent.session_id === 'string' &&
          sanitizedEvent.session_id.length > 0
            ? sanitizedEvent.session_id
            : undefined;
        if (discoveredSessionId && discoveredSessionId !== record.nativeSessionId) {
          record.nativeSessionId = discoveredSessionId;
          this.notifyStatus(record);
        }
        this.pushEvent(record, sanitizedEvent);
      }
      const result = await resultPromise;
      if (record.controller.signal.aborted || record.status === 'aborted') return;

      if (result.sessionId) record.nativeSessionId = result.sessionId;
      record.result = this.sanitizeResult(result, secrets);
      if (result.isError) {
        record.error = {
          name: 'ExternalCliRunError',
          message: redactString(result.stopReason || result.text || 'External CLI run failed.', secrets),
        };
        this.pushLog(record, 'error', 'Run failed.');
        this.transition(record, 'failed');
      } else {
        this.pushLog(record, 'info', 'Run completed.');
        this.transition(record, 'completed');
      }
    } catch (error) {
      if (record.controller.signal.aborted || record.status === 'aborted') return;
      record.error = sanitizeError(error, secrets);
      this.pushLog(record, 'error', 'Run failed.');
      this.transition(record, 'failed');
    }
  }

  private async getRuntime(
    record: RunRecord,
    options: ExternalCliRunStartOptions,
  ): Promise<CachedRuntime> {
    const cached = this.runtimes.get(record.cacheKey);
    if (cached) return cached;
    const pending = this.runtimePromises.get(record.cacheKey);
    if (pending) return pending;

    const create = (async () => {
      const client = await this.clientFactory({
        ...options.clientOptions,
        directCli: true,
        workDir: record.cwd,
        env:
          options.env || options.clientOptions?.env
            ? { ...options.clientOptions?.env, ...options.env }
            : undefined,
      });
      try {
        const session = options.nativeSessionId
          ? await client.resumeSession(options.nativeSessionId, {
              ...options.sessionOptions,
              directCli: true,
              workDir: record.cwd,
            })
          : await client.createSession({
              ...options.sessionOptions,
              directCli: true,
              workDir: record.cwd,
            });
        const runtime = { client, session };
        this.runtimes.set(record.cacheKey, runtime);
        return runtime;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    })();
    this.runtimePromises.set(record.cacheKey, create);
    try {
      return await create;
    } finally {
      if (this.runtimePromises.get(record.cacheKey) === create) {
        this.runtimePromises.delete(record.cacheKey);
      }
    }
  }

  private sanitizeResult(
    result: ActoviqBridgeRunResult,
    secrets: readonly string[],
  ): ExternalCliRunResultSnapshot {
    return {
      text: redactString(result.text, secrets),
      nativeSessionId: result.sessionId,
      isError: result.isError,
      subtype: result.subtype,
      stopReason: result.stopReason ? redactString(result.stopReason, secrets) : undefined,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
      numTurns: result.numTurns,
      exitCode: result.exitCode,
      stderr: redactString(result.stderr, secrets),
    };
  }

  private pushEvent(record: RunRecord, event: ActoviqBridgeJsonEvent): void {
    const originalBytes = serializedBytes(event);
    let boundedEvent = originalBytes > this.maxEventBytes
      ? truncateEvent(event, originalBytes)
      : event;
    const entry: ExternalCliRunEvent = {
      kind: 'event',
      sequence: record.nextSequence++,
      timestamp: this.now(),
      event: boundedEvent,
    };
    if (serializedBytes([entry]) > this.maxEventBufferBytes) {
      boundedEvent = truncateEvent(event, originalBytes);
      entry.event = boundedEvent;
    }
    record.events.push(entry);
    if (record.events.length > this.eventCapacity) record.events.shift();
    trimToByteCapacity(record.events, this.maxEventBufferBytes);
    this.notify(record, copyEvent(entry));
  }

  private pushLog(record: RunRecord, level: 'info' | 'error', message: string): void {
    const entry: ExternalCliRunLog = {
      kind: 'log',
      sequence: record.nextSequence++,
      timestamp: this.now(),
      level,
      message: truncateUtf8(message, this.maxLogBytes),
    };
    const emptyMessageBytes = serializedBytes([{ ...entry, message: '' }]);
    if (serializedBytes([entry]) > this.maxLogBufferBytes) {
      entry.message = truncateUtf8(
        message,
        Math.max(16, this.maxLogBufferBytes - emptyMessageBytes),
      );
    }
    record.logs.push(entry);
    if (record.logs.length > this.logCapacity) record.logs.shift();
    trimToByteCapacity(record.logs, this.maxLogBufferBytes);
    this.notify(record, copyLog(entry));
  }

  private transition(record: RunRecord, status: ExternalCliRunStatus): void {
    if (isTerminal(record.status)) return;
    record.status = status;
    if (isTerminal(status)) {
      record.finishedAt = this.now();
      this.terminalRunIds.add(record.runId);
    }
    this.notifyStatus(record);
    this.pruneRetainedRuns();
  }

  private pruneRetainedRuns(): void {
    while (this.runs.size > this.maxRetainedRuns) {
      const runId = this.terminalRunIds.values().next().value;
      if (runId === undefined) return;
      this.terminalRunIds.delete(runId);
      this.runs.delete(runId);
    }
  }

  private notifyStatus(record: RunRecord): void {
    this.notify(record, { kind: 'status', run: this.snapshot(record) });
  }

  private notify(record: RunRecord, update: ExternalCliRunUpdate): void {
    for (const subscriber of record.subscribers) subscriber(update);
  }

  private snapshot(record: RunRecord): ExternalCliRunSnapshot {
    return {
      runId: record.runId,
      actoviqSessionId: record.actoviqSessionId,
      configId: record.configId,
      cwd: record.cwd,
      background: record.background,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      nativeSessionId: record.nativeSessionId,
      result: record.result ? { ...record.result } : undefined,
      error: record.error ? { ...record.error } : undefined,
      events: record.events.map(copyEvent),
      logs: record.logs.map(copyLog),
    };
  }
}

export function createExternalCliRuntimeManager(
  options: ExternalCliRuntimeManagerOptions = {},
): ExternalCliRuntimeManager {
  return new ExternalCliRuntimeManager(options);
}
