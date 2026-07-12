import { describe, expect, it, vi } from 'vitest';

import {
  ToolExecutionError,
  ToolInterruptionRequiredError,
  ToolRegistry,
  ToolRunner,
  toolEffect,
  type RuntimeTool,
} from '../src/runtime-v2/tools.js';

const numberSchema = {
  parse(value: unknown): number {
    if (typeof value !== 'number') throw new TypeError('expected number');
    return value;
  },
};

function tool(overrides: Partial<RuntimeTool<unknown, number, number>> = {}): RuntimeTool<unknown, number, number> {
  return {
    descriptor: {
      name: 'double',
      description: 'Doubles a number.',
      input: numberSchema,
      output: numberSchema,
    },
    execute: (_context, input) => input * 2,
    ...overrides,
  };
}

function context(signal = new AbortController().signal) {
  return { runId: 'run-1', callId: 'call-1', signal, context: undefined };
}

describe('runtime-v2 tool contracts', () => {
  it('defaults undeclared tools to side-effect and rejects duplicate names', () => {
    const definition = tool();
    const registry = new ToolRegistry([definition]);
    expect(toolEffect(definition.descriptor)).toBe('side-effect');
    expect(() => registry.register(definition)).toThrow(/already registered/);
  });

  it('validates input and output around a single execution', async () => {
    const execute = vi.fn((_context, input: number) => input * 2);
    const runner = new ToolRunner({ registry: new ToolRegistry([tool({ execute })]) });

    await expect(runner.execute('double', 3, context())).resolves.toEqual({ value: 6 });
    await expect(runner.execute('double', '3', context())).rejects.toMatchObject({
      failure: { kind: 'validation' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('applies policy before invoking the executor', async () => {
    const execute = vi.fn();
    const runner = new ToolRunner({
      registry: new ToolRegistry([tool({ execute })]),
      policy: { authorize: () => ({ type: 'deny', reason: 'not permitted' }) },
    });

    await expect(runner.execute('double', 3, context())).rejects.toMatchObject({
      failure: { kind: 'denied', message: 'not permitted' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('turns approval into a serializable interruption without executing', async () => {
    const execute = vi.fn();
    const definition = tool({
      descriptor: {
        name: 'double',
        description: 'Doubles a number.',
        input: numberSchema,
        output: numberSchema,
        behavior: { requiresApproval: true },
      },
      execute,
    });
    const runner = new ToolRunner({ registry: new ToolRegistry([definition]) });

    await expect(runner.execute('double', 3, context())).rejects.toBeInstanceOf(
      ToolInterruptionRequiredError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('never lets an approval bypass an explicit runtime policy denial', async () => {
    const execute = vi.fn();
    const definition = tool({
      descriptor: {
        name: 'double', description: 'Protected.', input: numberSchema,
        behavior: { requiresApproval: true },
      },
      execute,
    });
    const runner = new ToolRunner({
      registry: new ToolRegistry([definition]),
      policy: { authorize: () => ({ type: 'deny', reason: 'policy denied' }) },
    });

    await expect(runner.execute('double', 3, {
      ...context(),
      approval: { interruptionId: 'approved', outcome: 'approve' },
    })).rejects.toMatchObject({ failure: { kind: 'denied', message: 'policy denied' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('bounds an executor that ignores cancellation', async () => {
    const definition = tool({
      descriptor: {
        name: 'double',
        description: 'Never returns.',
        input: numberSchema,
        behavior: { timeoutMs: 10 },
      },
      execute: () => new Promise<number>(() => undefined),
    });
    const runner = new ToolRunner({ registry: new ToolRegistry([definition]) });

    const error = await runner.execute('double', 3, context()).catch(value => value);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error.failure.kind).toBe('timeout');
  });
});
