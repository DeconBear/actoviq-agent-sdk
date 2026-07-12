import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeCapabilityMap,
  resolveAllowedCapabilities,
} from './capabilities.js';
import {
  WorkflowAbortedError,
  WorkflowConfigurationError,
  WorkflowExecutionError,
  WorkflowExecutorError,
  WorkflowMessageLimitError,
  WorkflowOutputLimitError,
  WorkflowProtocolError,
  WorkflowTimeoutError,
  WorkflowTrustTierError,
} from './errors.js';
import { cloneJsonValue, encodeProtocolMessage } from './json.js';
import {
  resolveRunTimeout,
  resolveWorkflowExecutorLimits,
} from './limits.js';
import { createLocalProcessChildSource } from './localProcessChild.js';
import type {
  JsonValue,
  SandboxWorkflowExecutor,
  UntrustedWorkflowExecutionRequest,
  WorkflowCapabilityMap,
  WorkflowExecutionResult,
  WorkflowExecutorLimits,
} from './types.js';

export interface LocalIsolatedProcessWorkflowExecutorOptions extends WorkflowExecutorLimits {
  readonly capabilities?: WorkflowCapabilityMap;
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Separate-process executor with no inherited environment and an allowlisted
 * JSON-RPC bridge. The child also enables Node's permission model with no fs,
 * child-process, worker, addon, or WASI grants.
 *
 * This boundary prevents ambient capability access and accidental host
 * mutation. It is not a container and does not claim resistance to every
 * future Node or node:vm escape; use a container/remote implementation of
 * SandboxWorkflowExecutor for adversarial multi-tenant workloads.
 */
export class LocalIsolatedProcessWorkflowExecutor implements SandboxWorkflowExecutor {
  readonly kind = 'local-isolated-process';
  readonly isolation = 'local-process' as const;
  private readonly limits;
  private readonly capabilities;
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>();

  constructor(options: LocalIsolatedProcessWorkflowExecutorOptions = {}) {
    this.limits = resolveWorkflowExecutorLimits(options);
    this.capabilities = normalizeCapabilityMap(options.capabilities);
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
      throw new WorkflowConfigurationError(
        'Local isolated workflows require Node 22+ permission-model support.',
      );
    }
  }

  get activeProcessCount(): number {
    return this.activeChildren.size;
  }

  async execute(
    request: UntrustedWorkflowExecutionRequest,
  ): Promise<WorkflowExecutionResult> {
    if (request.trust !== 'untrusted') {
      throw new WorkflowTrustTierError('untrusted', request.trust);
    }
    if (request.signal?.aborted) {
      throw new WorkflowAbortedError(request.signal.reason);
    }
    if (typeof request.source !== 'string' || request.source.trim().length === 0) {
      throw new WorkflowExecutionError('Workflow source must be a non-empty string.');
    }
    const workspaceDir = await resolveWorkspace(request.workspaceDir);
    if (request.signal?.aborted) {
      throw new WorkflowAbortedError(request.signal.reason);
    }

    const timeoutMs = resolveRunTimeout(request.timeoutMs, this.limits.timeoutMs);
    const allowed = resolveAllowedCapabilities(request.capabilities, this.capabilities);
    const input = cloneJsonValue(request.input ?? null, this.limits.maxMessageBytes);
    const childSource = createLocalProcessChildSource();
    if (process.platform === 'win32' && childSource.length > 20_000) {
      throw new WorkflowConfigurationError(
        'Local workflow child bootstrap exceeds the safe Windows command-line length.',
      );
    }

    const executeId = 'workflow:execute';
    const initialMessage = encodeProtocolMessage({
      jsonrpc: '2.0',
      id: executeId,
      method: 'workflow.execute',
      params: {
        source: request.source,
        input,
        capabilities: allowed,
        vmTimeoutMs: timeoutMs,
        maxOutputBytes: this.limits.maxOutputBytes,
        maxMessageBytes: this.limits.maxMessageBytes,
        maxProtocolMessages: this.limits.maxProtocolMessages,
      },
    }, this.limits.maxMessageBytes);

    const child = spawn(process.execPath, [
      permissionModelFlag(),
      '--disable-proto=throw',
      '--input-type=module',
      '--eval',
      childSource,
    ], {
      cwd: workspaceDir,
      env: {},
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.activeChildren.add(child);

    const startedAt = Date.now();
    return new Promise<WorkflowExecutionResult>((resolve, reject) => {
      let settled = false;
      let capabilityCalls = 0;
      let protocolMessages = 0;
      let stderrBytes = 0;
      let stderr = '';
      let delivered = false;
      const lifecycleController = new AbortController();
      const signal = request.signal
        ? AbortSignal.any([request.signal, lifecycleController.signal])
        : lifecycleController.signal;
      const decoder = new LimitedNdjsonDecoder(this.limits.maxMessageBytes);
      const timeoutError = new WorkflowTimeoutError(timeoutMs);

      const finish = (
        outcome: { readonly result: WorkflowExecutionResult } | { readonly error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (!lifecycleController.signal.aborted) {
          lifecycleController.abort(new WorkflowAbortedError('Workflow child closed.'));
        }
        const deliver = () => {
          if (delivered) return;
          delivered = true;
          this.activeChildren.delete(child);
          if ('error' in outcome) {
            reject(outcome.error);
          } else {
            resolve(outcome.result);
          }
        };
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
          deliver();
          return;
        }
        const reapTimer = setTimeout(() => {
          terminateChild(child);
          deliver();
        }, 1_000);
        reapTimer.unref?.();
        child.once('exit', () => {
          clearTimeout(reapTimer);
          deliver();
        });
        terminateChild(child);
      };
      const fail = (error: unknown) => finish({ error });
      const onAbort = () => {
        const reason = signal.reason;
        fail(reason instanceof WorkflowTimeoutError
          ? reason
          : new WorkflowAbortedError(reason));
      };
      const timer = setTimeout(() => lifecycleController.abort(timeoutError), timeoutMs);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      const countMessage = () => {
        protocolMessages += 1;
        if (protocolMessages > this.limits.maxProtocolMessages) {
          throw new WorkflowMessageLimitError(
            this.limits.maxMessageBytes,
            'Workflow protocol message count',
          );
        }
      };

      const sendToChild = (message: unknown) => {
        if (settled) return;
        let encoded: string;
        try {
          countMessage();
          encoded = encodeProtocolMessage(message, this.limits.maxMessageBytes);
        } catch (error) {
          fail(error);
          return;
        }
        child.stdin.write(encoded, error => {
          if (error && !settled) {
            fail(new WorkflowProtocolError('Failed to write to workflow child.', {
              cause: error,
            }));
          }
        });
      };

      const handleCapabilityCall = async (message: JsonRpcMessage): Promise<void> => {
        const id = message.id;
        const params = isRecord(message.params) ? message.params : undefined;
        const name = params?.name;
        if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') {
          fail(new WorkflowProtocolError('Malformed capability.call request.'));
          return;
        }
        if (!allowed.includes(name)) {
          sendToChild({
            jsonrpc: '2.0',
            id,
            error: {
              code: 'WORKFLOW_CAPABILITY_NOT_ALLOWED',
              message: `Capability "${name}" is not declared for this run.`,
            },
          });
          return;
        }
        const handler = this.capabilities.get(name);
        if (!handler) {
          sendToChild({
            jsonrpc: '2.0',
            id,
            error: {
              code: 'WORKFLOW_CAPABILITY_NOT_ALLOWED',
              message: `Capability "${name}" is unavailable.`,
            },
          });
          return;
        }

        capabilityCalls += 1;
        try {
          signal.throwIfAborted();
          const capabilityInput = cloneJsonValue(
            params?.input ?? null,
            this.limits.maxMessageBytes,
          );
          const rawOutput = await handler(capabilityInput, {
            name,
            trust: 'untrusted',
            signal,
            workspaceDir,
          });
          signal.throwIfAborted();
          const output = cloneJsonValue(rawOutput, this.limits.maxMessageBytes);
          sendToChild({ jsonrpc: '2.0', id, result: output });
        } catch (error) {
          if (settled) return;
          const code = error instanceof WorkflowExecutorError
            ? error.code
            : 'WORKFLOW_CAPABILITY_FAILED';
          const messageText = error instanceof Error ? error.message : String(error);
          sendToChild({
            jsonrpc: '2.0',
            id,
            error: { code, message: messageText.slice(0, 2_048) },
          });
        }
      };

      const handleMessage = (message: JsonRpcMessage) => {
        if (message.jsonrpc !== '2.0') {
          fail(new WorkflowProtocolError('Workflow child emitted a non-JSON-RPC message.'));
          return;
        }
        if (message.method === 'capability.call') {
          void handleCapabilityCall(message);
          return;
        }
        if (message.id !== executeId) {
          fail(new WorkflowProtocolError(
            `Workflow child emitted an unexpected response id: ${String(message.id)}.`,
          ));
          return;
        }
        if (message.error !== undefined) {
          fail(mapRemoteError(message.error, timeoutMs, this.limits));
          return;
        }
        try {
          const value = cloneJsonValue(
            message.result,
            this.limits.maxOutputBytes,
            'output',
          );
          finish({
            result: Object.freeze({
              value,
              trust: 'untrusted',
              executor: this.kind,
              durationMs: Date.now() - startedAt,
              capabilityCalls,
            }),
          });
        } catch (error) {
          fail(error);
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        let lines: readonly string[];
        try {
          lines = decoder.push(chunk);
        } catch (error) {
          fail(error);
          return;
        }
        for (const line of lines) {
          if (settled) return;
          let message: JsonRpcMessage;
          try {
            countMessage();
            message = JSON.parse(line) as JsonRpcMessage;
          } catch (error) {
            fail(error instanceof WorkflowExecutorError
              ? error
              : new WorkflowProtocolError('Workflow child emitted invalid JSON.', {
                cause: error,
              }));
            return;
          }
          handleMessage(message);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > this.limits.maxMessageBytes) {
          fail(new WorkflowMessageLimitError(
            this.limits.maxMessageBytes,
            'Workflow child diagnostics',
          ));
          return;
        }
        stderr += chunk.toString('utf8');
      });
      child.once('error', error => {
        fail(new WorkflowProtocolError('Failed to start workflow child process.', {
          cause: error,
        }));
      });
      child.once('exit', (code, exitSignal) => {
        if (settled) return;
        const detail = stderr.trim().slice(0, 2_048);
        fail(new WorkflowProtocolError(
          `Workflow child exited before a result (code=${String(code)}, signal=${String(exitSignal)})`
          + (detail ? `: ${detail}` : '.'),
        ));
      });

      sendToChild(JSON.parse(initialMessage) as unknown);
    });
  }
}

function permissionModelFlag(): '--experimental-permission' | '--permission' {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  return nodeMajor >= 24 ? '--permission' : '--experimental-permission';
}

class LimitedNdjsonDecoder {
  private readonly fragments: Buffer[] = [];
  private bufferedBytes = 0;

  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer): readonly string[] {
    const lines: string[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline >= 0 ? newline : chunk.length;
      this.append(chunk.subarray(offset, end));
      if (newline < 0) break;
      let line = Buffer.concat(this.fragments, this.bufferedBytes).toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.fragments.length = 0;
      this.bufferedBytes = 0;
      if (line.length === 0) {
        throw new WorkflowProtocolError('Workflow child emitted an empty protocol line.');
      }
      lines.push(line);
      offset = newline + 1;
    }
    return lines;
  }

  private append(fragment: Buffer): void {
    if (fragment.length === 0) return;
    if (this.bufferedBytes + fragment.length > this.maxMessageBytes) {
      throw new WorkflowMessageLimitError(this.maxMessageBytes);
    }
    this.fragments.push(Buffer.from(fragment));
    this.bufferedBytes += fragment.length;
  }
}

async function resolveWorkspace(workspaceDir: string): Promise<string> {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
    throw new WorkflowConfigurationError(
      'Untrusted workflow execution requires an explicit workspaceDir.',
    );
  }
  if (!path.isAbsolute(workspaceDir)) {
    throw new WorkflowConfigurationError('workspaceDir must be an absolute path.');
  }
  let resolved: string;
  try {
    resolved = await realpath(workspaceDir);
    const metadata = await stat(resolved);
    if (!metadata.isDirectory()) {
      throw new WorkflowConfigurationError('workspaceDir must identify a directory.');
    }
  } catch (error) {
    if (error instanceof WorkflowConfigurationError) throw error;
    throw new WorkflowConfigurationError('workspaceDir does not exist or is inaccessible.', {
      cause: error,
    });
  }
  return resolved;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.kill('SIGKILL');
}

function mapRemoteError(
  remoteValue: unknown,
  timeoutMs: number,
  limits: { readonly maxOutputBytes: number; readonly maxMessageBytes: number },
): Error {
  const remote = isRecord(remoteValue) ? remoteValue : {};
  const code = typeof remote.code === 'string' ? remote.code : 'WORKFLOW_EXECUTION_FAILED';
  const message = typeof remote.message === 'string'
    ? remote.message.slice(0, 2_048)
    : 'Workflow child execution failed.';
  if (code === 'WORKFLOW_TIMEOUT') {
    return new WorkflowTimeoutError(timeoutMs);
  }
  if (code === 'WORKFLOW_OUTPUT_LIMIT_EXCEEDED') {
    return new WorkflowOutputLimitError(limits.maxOutputBytes);
  }
  if (code === 'WORKFLOW_MESSAGE_LIMIT_EXCEEDED') {
    return new WorkflowMessageLimitError(limits.maxMessageBytes);
  }
  if (code === 'WORKFLOW_CAPABILITY_NOT_ALLOWED') {
    return new WorkflowExecutionError(message, { remoteCode: code });
  }
  return new WorkflowExecutionError(message, { remoteCode: code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
