import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LocalIsolatedProcessWorkflowExecutor,
  TrustedCompatibilityWorkflowExecutor,
  UntrustedWorkflowRejectedError,
  WorkflowAbortedError,
  WorkflowCapabilityNotAllowedError,
  WorkflowExecutorRouter,
  WorkflowMessageLimitError,
  WorkflowOutputLimitError,
  WorkflowTimeoutError,
} from '../src/workflow-v2/index.js';
import type {
  SandboxWorkflowExecutor,
  UntrustedWorkflowExecutionRequest,
  WorkflowExecutionResult,
} from '../src/workflow-v2/index.js';

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), 'actoviq-workflow-v2-'));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
  delete process.env.ACTOVIQ_WORKFLOW_HOST_SECRET;
});

function untrustedRequest(
  source: string,
  overrides: Partial<UntrustedWorkflowExecutionRequest> = {},
): UntrustedWorkflowExecutionRequest {
  return {
    trust: 'untrusted',
    source,
    workspaceDir,
    ...overrides,
  };
}

describe('workflow v2 trust routing', () => {
  it('rejects untrusted source by default', async () => {
    const router = new WorkflowExecutorRouter();

    await expect(router.execute(untrustedRequest('async () => null')))
      .rejects.toBeInstanceOf(UntrustedWorkflowRejectedError);
  });

  it('delegates untrusted source only to an explicitly supplied sandbox executor', async () => {
    const execute = vi.fn(async (
      _request: UntrustedWorkflowExecutionRequest,
    ): Promise<WorkflowExecutionResult> => ({
      value: { remote: true },
      trust: 'untrusted',
      executor: 'test-remote',
      durationMs: 1,
      capabilityCalls: 0,
    }));
    const remote: SandboxWorkflowExecutor = {
      kind: 'test-remote',
      isolation: 'remote',
      execute,
    };
    const router = new WorkflowExecutorRouter({ sandboxExecutor: remote });
    const request = untrustedRequest('async () => ({ remote: true })');

    await expect(router.execute(request)).resolves.toMatchObject({
      executor: 'test-remote',
      trust: 'untrusted',
    });
    expect(execute).toHaveBeenCalledWith(request);
  });

  it('keeps the trusted compatibility executor behind wall deadline and cancellation', async () => {
    const executor = new TrustedCompatibilityWorkflowExecutor({ timeoutMs: 1_000 });

    await expect(executor.execute({
      trust: 'trusted',
      source: 'async ({ input }) => ({ echoed: input })',
      input: 'ok',
    })).resolves.toMatchObject({
      value: { echoed: 'ok' },
      trust: 'trusted',
      executor: 'trusted-node-vm-compatibility',
    });

    await expect(executor.execute({
      trust: 'trusted',
      source: 'async () => new Promise(() => {})',
      timeoutMs: 30,
    })).rejects.toBeInstanceOf(WorkflowTimeoutError);

    const controller = new AbortController();
    const pending = executor.execute({
      trust: 'trusted',
      source: 'async () => new Promise(() => {})',
      signal: controller.signal,
    });
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortedError);
  });
});

describe('local isolated-process workflow security boundary', () => {
  it('does not inherit a host secret or expose process/require/network globals', async () => {
    process.env.ACTOVIQ_WORKFLOW_HOST_SECRET = 'must-not-cross-boundary';
    const executor = new LocalIsolatedProcessWorkflowExecutor();
    const source = `async ({ input }) => {
      let escapedSecret = 'blocked';
      let inputConstructorEscape = 'blocked';
      try {
        escapedSecret = globalThis.constructor.constructor(
          'return process.env.ACTOVIQ_WORKFLOW_HOST_SECRET'
        )();
      } catch {}
      try {
        inputConstructorEscape = input.constructor.constructor(
          'return typeof process'
        )();
      } catch {}
      return {
        processType: typeof process,
        requireType: typeof require,
        fetchType: typeof fetch,
        escapedSecret,
        inputConstructorEscape,
      };
    }`;

    const result = await executor.execute(untrustedRequest(source, {
      input: { probe: true },
    }));

    expect(result.value).toEqual({
      processType: 'undefined',
      requireType: 'undefined',
      fetchType: 'undefined',
      escapedSecret: 'blocked',
      inputConstructorEscape: 'blocked',
    });
    expect(JSON.stringify(result.value)).not.toContain('must-not-cross-boundary');
  });

  it('makes fs, net, and child_process unavailable through require and dynamic import', async () => {
    const executor = new LocalIsolatedProcessWorkflowExecutor();
    const source = `async () => {
      const result = { requireType: typeof require };
      for (const specifier of ['node:fs', 'node:net', 'node:child_process']) {
        try {
          await import(specifier);
          result[specifier] = 'available';
        } catch {
          result[specifier] = 'blocked';
        }
      }
      return result;
    }`;

    await expect(executor.execute(untrustedRequest(source))).resolves.toMatchObject({
      value: {
        requireType: 'undefined',
        'node:fs': 'blocked',
        'node:net': 'blocked',
        'node:child_process': 'blocked',
      },
    });
  });

  it('terminates a child that exceeds wall time or is aborted', async () => {
    const executor = new LocalIsolatedProcessWorkflowExecutor({ timeoutMs: 2_000 });

    await expect(executor.execute(untrustedRequest(
      'async () => new Promise(() => {})',
      { timeoutMs: 40 },
    ))).rejects.toBeInstanceOf(WorkflowTimeoutError);
    expect(executor.activeProcessCount).toBe(0);

    const controller = new AbortController();
    const pending = executor.execute(untrustedRequest(
      'async () => new Promise(() => {})',
      { signal: controller.signal },
    ));
    await vi.waitFor(() => expect(executor.activeProcessCount).toBe(1));
    controller.abort(new Error('stop isolated workflow'));
    await expect(pending).rejects.toBeInstanceOf(WorkflowAbortedError);
    expect(executor.activeProcessCount).toBe(0);
  });

  it('rejects oversized output and oversized protocol input', async () => {
    const outputBounded = new LocalIsolatedProcessWorkflowExecutor({
      maxOutputBytes: 128,
      maxMessageBytes: 8_192,
    });
    await expect(outputBounded.execute(untrustedRequest(
      `async () => 'x'.repeat(10_000)`,
    ))).rejects.toBeInstanceOf(WorkflowOutputLimitError);
    expect(outputBounded.activeProcessCount).toBe(0);

    const messageBounded = new LocalIsolatedProcessWorkflowExecutor({
      maxMessageBytes: 1_024,
    });
    await expect(messageBounded.execute(untrustedRequest(
      `async () => null /* ${'x'.repeat(2_000)} */`,
    ))).rejects.toBeInstanceOf(WorkflowMessageLimitError);
    expect(messageBounded.activeProcessCount).toBe(0);
  });

  it('exposes only per-run declared RPC capabilities', async () => {
    const echo = vi.fn(async (input, context) => ({
      input,
      trust: context.trust,
      workspaceDir: context.workspaceDir,
    }));
    const hidden = vi.fn(async () => 'host-only');
    const executor = new LocalIsolatedProcessWorkflowExecutor({
      capabilities: { echo, hidden },
    });
    const source = `async ({ capabilities }) => {
      let hiddenCall = 'blocked';
      let capabilityConstructorEscape = 'blocked';
      try {
        hiddenCall = await capabilities.hidden(null);
      } catch {}
      try {
        capabilityConstructorEscape = capabilities.echo.constructor(
          'return typeof process'
        )();
      } catch {}
      return {
        echo: await capabilities.echo({ value: 'hello' }),
        hiddenType: typeof capabilities.hidden,
        hiddenCall,
        capabilityConstructorEscape,
      };
    }`;

    const result = await executor.execute(untrustedRequest(source, {
      capabilities: ['echo'],
    }));
    expect(result.value).toEqual({
      echo: {
        input: { value: 'hello' },
        trust: 'untrusted',
        workspaceDir,
      },
      hiddenType: 'undefined',
      hiddenCall: 'blocked',
      capabilityConstructorEscape: 'blocked',
    });
    expect(result.capabilityCalls).toBe(1);
    expect(echo).toHaveBeenCalledOnce();
    expect(hidden).not.toHaveBeenCalled();

    await expect(executor.execute(untrustedRequest('async () => null', {
      capabilities: ['missing'],
    }))).rejects.toBeInstanceOf(WorkflowCapabilityNotAllowedError);
    expect(executor.activeProcessCount).toBe(0);
  });
});
