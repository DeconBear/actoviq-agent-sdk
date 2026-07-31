import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import readline from 'node:readline';

import type {
  HadamardBridgeJsonEvent,
  HadamardBridgePermissionMode,
} from '../types.js';
import { IS_WINDOWS } from './bridgeExecResolver.js';
import { terminateManagedProcessTree } from './bridgeProcessTree.js';
import {
  createReasonixAcpSession,
  type ReasonixAcpHandleResult,
  type ReasonixAcpJsonRpcRecord,
  type ReasonixAcpSession,
} from './reasonixAcpSession.js';

const ABORT_GRACE_MS = 300;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;

export type ReasonixSpawnFn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CreateReasonixManagedClientOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  nativeSessionId?: string;
  secrets?: readonly string[];
  spawnFn?: ReasonixSpawnFn;
  onSpawn?: (child: ChildProcess) => void;
}

export interface ReasonixManagedTurnOptions {
  prompt: string;
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  permissionMode: HadamardBridgePermissionMode;
  signal?: AbortSignal;
  onEvent?: (event: HadamardBridgeJsonEvent) => void;
}

export interface ReasonixManagedTurnResult {
  sessionId: string;
  stderr: string;
  exitCode: number | null;
  reusable: boolean;
}

interface ActiveTurn {
  onEvent?: (event: HadamardBridgeJsonEvent) => void;
  resolve: (result: { sessionId: string; reusable: boolean }) => void;
  reject: (error: Error) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function abortError(message = 'Reasonix managed run was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
      '$1[REDACTED]',
    );
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, redactValue(child, secrets)]),
  );
}

export class ReasonixManagedClient {
  private readonly spawnFn: ReasonixSpawnFn;
  private readonly secrets: readonly string[];
  private child: ChildProcess | undefined;
  private protocol: ReasonixAcpSession | undefined;
  private readerTask: Promise<void> | undefined;
  private activeTurn: ActiveTurn | undefined;
  private queueTail: Promise<void> = Promise.resolve();
  private terminationPromise: Promise<void> | undefined;
  private processError: Error | undefined;
  private stderrValue = '';
  private closed = false;
  private broken = false;

  constructor(private readonly options: CreateReasonixManagedClientOptions) {
    this.spawnFn = options.spawnFn ?? ((file, args, spawnOptions) =>
      spawn(file, [...args], spawnOptions));
    this.secrets = [...new Set(options.secrets ?? [])]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
  }

  run(options: ReasonixManagedTurnOptions): Promise<ReasonixManagedTurnResult> {
    const queued = this.queueTail.then(() => this.runExclusive(options));
    this.queueTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async close(): Promise<void> {
    if (this.closed && !this.child) return;
    this.closed = true;
    const active = this.activeTurn;
    // Match AbortSignal: send session/cancel and allow a short grace window so
    // the child can record/ack cancellation before process-tree termination.
    // Do not gate on activeTurn — protocol may still need cancel after races.
    if (this.protocol) {
      this.writeAll(this.protocol.cancel());
      await new Promise(resolve => setTimeout(resolve, ABORT_GRACE_MS));
    }
    await this.terminate();
    active?.reject(new Error('Reasonix managed client was closed.'));
    await this.queueTail.catch(() => undefined);
    await this.readerTask?.catch(() => undefined);
  }

  private async runExclusive(
    options: ReasonixManagedTurnOptions,
  ): Promise<ReasonixManagedTurnResult> {
    if (this.closed) throw new Error('Reasonix managed client is closed.');
    if (this.broken) throw new Error('Reasonix managed client cannot be reused.');
    if (options.signal?.aborted) throw abortError();

    if (!this.child) this.startProcess();
    if (this.processError) throw this.processError;

    const completion = new Promise<{ sessionId: string; reusable: boolean }>((resolve, reject) => {
      this.activeTurn = { onEvent: options.onEvent, resolve, reject };
    });

    try {
      if (!this.protocol) {
        this.protocol = createReasonixAcpSession({
          prompt: options.prompt,
          cwd: this.options.cwd,
          model: options.model,
          effort: options.effort,
          maxBudgetUsd: options.maxBudgetUsd,
          permissionMode: options.permissionMode,
          nativeSessionId: this.options.nativeSessionId,
        });
        this.writeAll(this.protocol.start());
      } else {
        this.applyProtocolResult(this.protocol.nextTurn({
          prompt: options.prompt,
          model: options.model,
          effort: options.effort,
          maxBudgetUsd: options.maxBudgetUsd,
          permissionMode: options.permissionMode,
        }));
      }
    } catch (error) {
      this.activeTurn = undefined;
      throw error;
    }

    let aborted = false;
    let abortTask: Promise<void> | undefined;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      if (this.protocol) this.writeAll(this.protocol.cancel());
      abortTask = (async () => {
        await new Promise(resolve => setTimeout(resolve, ABORT_GRACE_MS));
        this.broken = true;
        await this.terminate();
      })();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    try {
      const result = await completion;
      if (aborted) {
        await abortTask;
        throw abortError();
      }
      if (!result.reusable) {
        this.broken = true;
        await this.terminate();
      }
      return {
        sessionId: result.sessionId,
        stderr: redactString(this.stderrValue, this.secrets),
        exitCode: this.child?.exitCode ?? null,
        reusable: result.reusable,
      };
    } catch (error) {
      if (aborted) {
        await abortTask;
        throw abortError();
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (this.activeTurn) this.activeTurn = undefined;
    }
  }

  private startProcess(): void {
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.options.executable, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: !IS_WINDOWS,
      });
    } catch (error) {
      this.broken = true;
      throw error;
    }
    this.child = child;
    this.options.onSpawn?.(child);
    child.stdin?.on('error', () => {
      // Process exit handling below reports the canonical failure.
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => this.captureStderr(String(chunk)));
    child.once('error', error => this.failProcess(error));
    child.once('close', (code, signal) => {
      if (!this.closed && !this.broken) {
        this.failProcess(new Error(
          `Reasonix ACP process exited unexpectedly (${code ?? signal ?? 'unknown'}).`,
        ));
      } else if (this.activeTurn) {
        this.activeTurn.reject(this.processError ?? new Error('Reasonix ACP process exited.'));
        this.activeTurn = undefined;
      }
    });
    this.readerTask = this.consumeStdout(child).catch(error => {
      this.failProcess(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async consumeStdout(child: ChildProcess): Promise<void> {
    if (!child.stdout) throw new Error('Reasonix ACP process has no stdout stream.');
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_JSON_LINE_BYTES) {
        throw new Error('Reasonix ACP emitted an oversized JSON-RPC record.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          `Reasonix ACP emitted malformed JSON: ${redactString(line, this.secrets)}`,
        );
      }
      const record = asRecord(parsed);
      if (!record) throw new Error('Reasonix ACP emitted a non-object JSON-RPC record.');
      if (!this.protocol) continue;
      this.applyProtocolResult(this.protocol.handle(record));
    }
  }

  private applyProtocolResult(result: ReasonixAcpHandleResult): void {
    this.writeAll(result.outbound);
    const active = this.activeTurn;
    if (!active) return;
    for (const event of result.events) {
      active.onEvent?.(redactValue(event, this.secrets) as HadamardBridgeJsonEvent);
    }
    if (!result.done) return;
    this.activeTurn = undefined;
    active.resolve({
      sessionId: result.nativeSessionId ?? '',
      reusable: this.protocol?.canContinue() === true,
    });
  }

  private writeAll(records: readonly ReasonixAcpJsonRpcRecord[]): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    for (const record of records) stdin.write(`${JSON.stringify(record)}\n`);
  }

  private captureStderr(chunk: string): void {
    if (Buffer.byteLength(this.stderrValue, 'utf8') >= MAX_STDERR_BYTES) return;
    this.stderrValue += chunk;
    if (Buffer.byteLength(this.stderrValue, 'utf8') > MAX_STDERR_BYTES) {
      this.stderrValue = Buffer.from(this.stderrValue, 'utf8')
        .subarray(0, MAX_STDERR_BYTES)
        .toString('utf8');
    }
  }

  private failProcess(error: Error): void {
    if (this.processError) return;
    this.broken = true;
    this.processError = new Error(redactString(error.message, this.secrets));
    this.processError.name = error.name;
    const active = this.activeTurn;
    this.activeTurn = undefined;
    active?.reject(this.processError);
  }

  private terminate(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.terminationPromise = (async () => {
      child.stdin?.end();
      await terminateManagedProcessTree(child);
      if (this.child === child) this.child = undefined;
    })();
    return this.terminationPromise;
  }
}

export function createReasonixManagedClient(
  options: CreateReasonixManagedClientOptions,
): ReasonixManagedClient {
  return new ReasonixManagedClient(options);
}
