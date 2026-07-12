import { Buffer } from 'node:buffer';
import vm from 'node:vm';

import { withWorkflowBoundary } from './boundary.js';
import {
  normalizeCapabilityMap,
  resolveAllowedCapabilities,
} from './capabilities.js';
import {
  WorkflowExecutionError,
  WorkflowOutputLimitError,
  WorkflowTimeoutError,
  WorkflowTrustTierError,
} from './errors.js';
import { assertJsonByteLimit, cloneJsonValue } from './json.js';
import {
  resolveRunTimeout,
  resolveWorkflowExecutorLimits,
} from './limits.js';
import type {
  JsonValue,
  TrustedWorkflowExecutionRequest,
  TrustedWorkflowExecutor,
  WorkflowCapabilityMap,
  WorkflowExecutionResult,
  WorkflowExecutorLimits,
} from './types.js';

export interface TrustedCompatibilityWorkflowExecutorOptions extends WorkflowExecutorLimits {
  readonly capabilities?: WorkflowCapabilityMap;
}

/**
 * In-process compatibility executor for explicitly trusted source only.
 * node:vm provides a separate context but is not a security boundary. Finite
 * VM and wall-clock deadlines still prevent ordinary runaway trusted scripts.
 */
export class TrustedCompatibilityWorkflowExecutor implements TrustedWorkflowExecutor {
  readonly kind = 'trusted-node-vm-compatibility';
  private readonly limits;
  private readonly capabilities;

  constructor(options: TrustedCompatibilityWorkflowExecutorOptions = {}) {
    this.limits = resolveWorkflowExecutorLimits(options);
    this.capabilities = normalizeCapabilityMap(options.capabilities);
  }

  async execute(
    request: TrustedWorkflowExecutionRequest,
  ): Promise<WorkflowExecutionResult> {
    if (request.trust !== 'trusted') {
      throw new WorkflowTrustTierError('trusted', request.trust);
    }
    if (typeof request.source !== 'string' || request.source.trim().length === 0) {
      throw new WorkflowExecutionError('Workflow source must be a non-empty string.');
    }

    const timeoutMs = resolveRunTimeout(request.timeoutMs, this.limits.timeoutMs);
    const allowed = resolveAllowedCapabilities(request.capabilities, this.capabilities);
    const input = cloneJsonValue(request.input ?? null, this.limits.maxMessageBytes);
    const sourceBytes = Buffer.byteLength(request.source, 'utf8');
    if (sourceBytes > this.limits.maxMessageBytes) {
      throw new WorkflowExecutionError(
        `Workflow source exceeds the ${this.limits.maxMessageBytes}-byte message limit.`,
      );
    }

    const startedAt = Date.now();
    const expiresAt = startedAt + timeoutMs;
    let capabilityCalls = 0;

    const value = await withWorkflowBoundary(timeoutMs, request.signal, async signal => {
      const contextObject = Object.create(null) as Record<string, unknown>;
      const capabilityObject = Object.create(null) as Record<
        string,
        (input?: JsonValue) => Promise<JsonValue>
      >;

      for (const name of allowed) {
        const handler = this.capabilities.get(name);
        if (!handler) continue;
        Object.defineProperty(capabilityObject, name, {
          enumerable: true,
          configurable: false,
          writable: false,
          value: async (capabilityInput: JsonValue = null): Promise<JsonValue> => {
            signal.throwIfAborted();
            capabilityCalls += 1;
            const safeInput = cloneJsonValue(
              capabilityInput,
              this.limits.maxMessageBytes,
            );
            const output = await handler(safeInput, {
              name,
              trust: 'trusted',
              signal,
            });
            signal.throwIfAborted();
            return cloneJsonValue(output, this.limits.maxMessageBytes);
          },
        });
      }
      Object.freeze(capabilityObject);

      Object.defineProperties(contextObject, {
        __actoviqInput: { value: input, configurable: false, writable: false },
        __actoviqCapabilities: {
          value: capabilityObject,
          configurable: false,
          writable: false,
        },
        __actoviqSignal: { value: signal, configurable: false, writable: false },
      });
      const context = vm.createContext(contextObject, {
        name: 'actoviq-trusted-workflow-compatibility',
      });
      const program = new vm.Script(
        [
          '"use strict";',
          `const __actoviqProgram = (${request.source});`,
          'if (typeof __actoviqProgram !== "function") {',
          '  throw new TypeError("Workflow source must evaluate to a function.");',
          '}',
          'Promise.resolve(__actoviqProgram({',
          '  input: globalThis.__actoviqInput,',
          '  capabilities: globalThis.__actoviqCapabilities,',
          '  signal: globalThis.__actoviqSignal,',
          '}));',
        ].join('\n'),
        { filename: 'trusted-workflow.js' },
      );

      let pending: PromiseLike<unknown>;
      try {
        pending = program.runInContext(context, {
          timeout: Math.max(1, expiresAt - Date.now()),
        }) as PromiseLike<unknown>;
      } catch (error) {
        if (isVmTimeout(error)) {
          throw new WorkflowTimeoutError(timeoutMs, { cause: error });
        }
        throw new WorkflowExecutionError(errorMessage(error), { cause: error });
      }

      let rawResult: unknown;
      try {
        rawResult = await pending;
      } catch (error) {
        throw new WorkflowExecutionError(errorMessage(error), { cause: error });
      }
      signal.throwIfAborted();

      Object.defineProperty(contextObject, '__actoviqResult', {
        value: rawResult,
        configurable: true,
      });
      let serialized: unknown;
      try {
        serialized = new vm.Script(
          'JSON.stringify(globalThis.__actoviqResult)',
          { filename: 'trusted-workflow-output.js' },
        ).runInContext(context, {
          timeout: Math.max(1, expiresAt - Date.now()),
        });
      } catch (error) {
        if (isVmTimeout(error)) {
          throw new WorkflowTimeoutError(timeoutMs, { cause: error });
        }
        throw new WorkflowExecutionError('Workflow output is not JSON serializable.', {
          cause: error,
        });
      } finally {
        delete contextObject.__actoviqResult;
      }
      if (typeof serialized !== 'string') {
        throw new WorkflowExecutionError('Workflow output must be a JSON value.');
      }
      try {
        assertJsonByteLimit(serialized, this.limits.maxOutputBytes, 'output');
      } catch (error) {
        if (error instanceof WorkflowOutputLimitError) throw error;
        throw new WorkflowExecutionError('Workflow output validation failed.', { cause: error });
      }
      return JSON.parse(serialized) as JsonValue;
    });

    return Object.freeze({
      value,
      trust: 'trusted',
      executor: this.kind,
      durationMs: Date.now() - startedAt,
      capabilityCalls,
    });
  }
}

function isVmTimeout(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
