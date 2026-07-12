import { describe, expect, it, vi } from 'vitest';

import {
  MIDDLEWARE_STAGE_ORDER,
  MiddlewareDeadlineExceededError,
  MiddlewareNextCalledTwiceError,
  MiddlewarePriorityConflictError,
  MiddlewareStage,
  buildMiddlewarePipeline,
  createMiddlewarePipelineBuilder,
  defineMiddleware,
} from '../src/runtime-v2/middleware/index.js';
import type {
  MiddlewareDeadline,
  MiddlewareDefinition,
  MiddlewareInvocationContext,
} from '../src/runtime-v2/middleware/index.js';

function liveContext(): MiddlewareInvocationContext {
  return { signal: new AbortController().signal };
}

function recorder(
  name: string,
  priority: number,
  calls: string[],
): MiddlewareDefinition<MiddlewareStage.BeforeRun, MiddlewareInvocationContext, string> {
  return defineMiddleware({
    name,
    stage: MiddlewareStage.BeforeRun,
    priority,
    async handle(_context, next) {
      calls.push(`${name}:before`);
      const result = await next();
      calls.push(`${name}:after`);
      return `${name}(${result})`;
    },
  });
}

describe('middleware v2 stages and ordering', () => {
  it('publishes the finite lifecycle stages in their specified order', () => {
    expect(MIDDLEWARE_STAGE_ORDER).toEqual([
      MiddlewareStage.PrepareInput,
      MiddlewareStage.BeforeRun,
      MiddlewareStage.WrapModelCall,
      MiddlewareStage.AfterModelResponse,
      MiddlewareStage.BeforeToolCall,
      MiddlewareStage.WrapToolCall,
      MiddlewareStage.AfterToolCall,
      MiddlewareStage.BeforeHandoff,
      MiddlewareStage.AfterTurn,
      MiddlewareStage.FinalizeOutput,
      MiddlewareStage.AfterRun,
      MiddlewareStage.OnError,
    ]);
  });

  it('sorts by stage and numeric priority, independent of registration/import order', async () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const firstDefinitions = [
      recorder('late', 50, firstCalls),
      recorder('early', -20, firstCalls),
      recorder('middle', 10, firstCalls),
    ];
    const secondDefinitions = [
      recorder('middle', 10, secondCalls),
      recorder('early', -20, secondCalls),
      recorder('late', 50, secondCalls),
    ];
    const first = buildMiddlewarePipeline(firstDefinitions);
    const second = buildMiddlewarePipeline(secondDefinitions);

    expect(first.inspect()).toEqual(second.inspect());
    expect(first.inspect(MiddlewareStage.BeforeRun).map(item => item.name)).toEqual([
      'early',
      'middle',
      'late',
    ]);
    expect(first.format(MiddlewareStage.BeforeRun)).toBe([
      'beforeRun[0] @-20 early',
      'beforeRun[1] @10 middle',
      'beforeRun[2] @50 late',
    ].join('\n'));

    await expect(first.run(MiddlewareStage.BeforeRun, liveContext(), async () => {
      firstCalls.push('terminal');
      return 'value';
    })).resolves.toBe('early(middle(late(value)))');
    await expect(second.run(MiddlewareStage.BeforeRun, liveContext(), async () => {
      secondCalls.push('terminal');
      return 'value';
    })).resolves.toBe('early(middle(late(value)))');
    expect(firstCalls).toEqual([
      'early:before',
      'middle:before',
      'late:before',
      'terminal',
      'late:after',
      'middle:after',
      'early:after',
    ]);
    expect(secondCalls).toEqual(firstCalls);
  });

  it('rejects same-stage priority collisions at build time', () => {
    const builder = createMiddlewarePipelineBuilder()
      .use(defineMiddleware({
        name: 'permissions',
        stage: MiddlewareStage.BeforeToolCall,
        priority: 100,
        handle: async (_context, next) => next(),
      }))
      .use(defineMiddleware({
        name: 'guardrails',
        stage: MiddlewareStage.BeforeToolCall,
        priority: 100,
        handle: async (_context, next) => next(),
      }));

    expect(() => builder.build()).toThrow(MiddlewarePriorityConflictError);
    try {
      builder.build();
    } catch (error) {
      expect(error).toMatchObject({
        stage: MiddlewareStage.BeforeToolCall,
        priority: 100,
        middlewareNames: ['guardrails', 'permissions'],
      });
    }
  });
});

describe('middleware v2 execution semantics', () => {
  it('supports intentional short-circuiting without running downstream work', async () => {
    const downstream = vi.fn(async () => 'downstream');
    const terminal = vi.fn(async () => 'terminal');
    const pipeline = buildMiddlewarePipeline([
      defineMiddleware({
        name: 'cache-hit',
        stage: MiddlewareStage.WrapModelCall,
        priority: 0,
        handle: async () => 'cached',
      }),
      defineMiddleware({
        name: 'provider',
        stage: MiddlewareStage.WrapModelCall,
        priority: 10,
        handle: downstream,
      }),
    ]);

    await expect(pipeline.run(
      MiddlewareStage.WrapModelCall,
      liveContext(),
      terminal,
    )).resolves.toBe('cached');
    expect(downstream).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it('routes unhandled failures through onError and allows explicit recovery', async () => {
    const failure = new Error('model unavailable');
    const seen: unknown[] = [];
    const pipeline = buildMiddlewarePipeline([
      defineMiddleware({
        name: 'error-mapper',
        stage: MiddlewareStage.OnError,
        priority: 0,
        handle: async (context) => {
          seen.push(context.failedStage, context.error, context.sourceContext);
          return 'recovered';
        },
      }),
    ]);
    const context = liveContext();

    await expect(pipeline.runWithErrorStage(
      MiddlewareStage.WrapModelCall,
      context,
      async () => {
        throw failure;
      },
    )).resolves.toBe('recovered');
    expect(seen).toEqual([MiddlewareStage.WrapModelCall, failure, context]);
  });

  it('preserves an original failure when onError delegates to next', async () => {
    const failure = new Error('tool failed');
    const pipeline = buildMiddlewarePipeline([
      defineMiddleware({
        name: 'error-observer',
        stage: MiddlewareStage.OnError,
        priority: 0,
        handle: async (_context, next) => next(),
      }),
    ]);

    await expect(pipeline.runWithErrorStage(
      MiddlewareStage.WrapToolCall,
      liveContext(),
      async () => {
        throw failure;
      },
    )).rejects.toBe(failure);
  });

  it('rejects calling next more than once', async () => {
    const pipeline = buildMiddlewarePipeline([
      defineMiddleware({
        name: 'invalid-around',
        stage: MiddlewareStage.AfterTurn,
        priority: 0,
        handle: async (_context, next) => {
          await next();
          return next();
        },
      }),
    ]);

    await expect(pipeline.run(
      MiddlewareStage.AfterTurn,
      liveContext(),
      async () => 'done',
    )).rejects.toBeInstanceOf(MiddlewareNextCalledTwiceError);
  });

  it('passes signal and deadline unchanged through every chain boundary', async () => {
    const controller = new AbortController();
    const deadline: MiddlewareDeadline = Object.freeze({
      expiresAt: Date.now() + 10_000,
      scope: 'model',
    });
    const observed: Array<[AbortSignal, MiddlewareDeadline | undefined, MiddlewareStage]> = [];
    const pipeline = buildMiddlewarePipeline([
      defineMiddleware({
        name: 'first',
        stage: MiddlewareStage.BeforeRun,
        priority: 0,
        handle: async (context, next) => {
          observed.push([context.signal, context.deadline, context.stage]);
          return next();
        },
      }),
      defineMiddleware({
        name: 'second',
        stage: MiddlewareStage.BeforeRun,
        priority: 10,
        handle: async (context, next) => {
          observed.push([context.signal, context.deadline, context.stage]);
          return next();
        },
      }),
    ]);

    await pipeline.run(
      MiddlewareStage.BeforeRun,
      { signal: controller.signal, deadline },
      async context => {
        observed.push([context.signal, context.deadline, context.stage]);
        return 'done';
      },
    );
    expect(observed).toHaveLength(3);
    for (const [signal, seenDeadline, stage] of observed) {
      expect(signal).toBe(controller.signal);
      expect(seenDeadline).toBe(deadline);
      expect(stage).toBe(MiddlewareStage.BeforeRun);
    }
  });

  it('stops before handlers for an aborted signal or expired deadline', async () => {
    const aborted = new AbortController();
    const reason = new Error('caller cancelled');
    aborted.abort(reason);
    const handler = vi.fn(async (_context, next) => next());
    const terminal = vi.fn(async () => 'done');
    const pipeline = buildMiddlewarePipeline([
      defineMiddleware({
        name: 'observer',
        stage: MiddlewareStage.PrepareInput,
        priority: 0,
        handle: handler,
      }),
    ]);

    await expect(pipeline.run(
      MiddlewareStage.PrepareInput,
      { signal: aborted.signal },
      terminal,
    )).rejects.toBe(reason);
    expect(handler).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();

    await expect(pipeline.run(
      MiddlewareStage.PrepareInput,
      {
        signal: new AbortController().signal,
        deadline: { expiresAt: Date.now() - 1, scope: 'input' },
      },
      terminal,
    )).rejects.toBeInstanceOf(MiddlewareDeadlineExceededError);
    expect(handler).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });
});
