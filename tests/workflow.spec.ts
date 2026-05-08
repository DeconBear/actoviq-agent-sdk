import { describe, expect, it, vi } from 'vitest';

import { WorkflowEngine } from '../src/workflow/workflowEngine.js';
import type {
  WorkflowDefinition,
  WorkflowStepResult,
  WorkflowRunResult,
} from '../src/workflow/types.js';

function createMockSdk() {
  const sessions: Array<{
    id: string;
    title: string;
    send: (prompt: string, opts: Record<string, unknown>) => Promise<{
      text: string;
      toolCalls: Array<{ name: string; outputText: string }>;
    }>;
  }> = [];

  const mockSend = vi.fn(
    async (prompt: string, _opts: Record<string, unknown>) => ({
      text: `result for: ${prompt}`,
      toolCalls: [],
      runId: 'run-1',
      model: 'test-model',
      message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
      messages: [],
      stopReason: 'end_turn' as const,
      requests: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
  );

  return {
    mockSend,
    config: { workDir: '/tmp/test' },
    createSession: vi.fn(async (opts: { title: string }) => {
      const session = {
        id: `sess_${sessions.length + 1}`,
        title: opts.title,
        send: (prompt: string, runOpts: Record<string, unknown>) =>
          mockSend(prompt, runOpts),
      };
      sessions.push(session);
      return session;
    }),
  };
}

describe('WorkflowEngine', () => {
  it('runs a single-step workflow', async () => {
    const sdk = createMockSdk();
    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'test-workflow',
      description: 'A test workflow',
      steps: [
        {
          id: 'step1',
          description: 'Step 1',
          prompt: 'Do something',
          dependsOn: [],
        },
      ],
    };

    const result = await engine.run(definition, {}, { workDir: '/tmp/test' });

    expect(result.workflowName).toBe('test-workflow');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('completed');
    expect(result.status).toBe('completed');
    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.mockSend).toHaveBeenCalledWith('Do something', expect.any(Object));
  });

  it('runs steps with dependencies in order', async () => {
    const executionOrder: string[] = [];
    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => {
        const id = opts.title.split('/')[1] ?? 'unknown';
        return {
          id: `sess_${id}`,
          title: opts.title,
          send: async (prompt: string, _opts: Record<string, unknown>) => {
            executionOrder.push(id);
            return {
              text: `result for: ${prompt}`,
              toolCalls: [],
              runId: 'run-1',
              model: 'test-model',
              message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
              messages: [],
              stopReason: 'end_turn' as const,
              requests: [],
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
          },
        };
      }),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'dag-test',
      description: 'DAG test',
      steps: [
        { id: 'a', description: 'A', prompt: 'Do A', dependsOn: [] },
        { id: 'b', description: 'B', prompt: 'Do B', dependsOn: ['a'] },
        { id: 'c', description: 'C', prompt: 'Do C', dependsOn: ['b'] },
      ],
    };

    await engine.run(definition, {}, { workDir: '/tmp/test' });

    expect(executionOrder).toEqual(['A', 'B', 'C']);
  });

  it('runs independent steps in parallel', async () => {
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => {
        const stepName = opts.title.split('/')[1] ?? 'unknown';
        return {
          id: `sess_${stepName}`,
          title: opts.title,
          send: async (_prompt: string, _opts: Record<string, unknown>) => {
            startTimes[stepName] = Date.now();
            await new Promise((r) => setTimeout(r, 50));
            endTimes[stepName] = Date.now();
            return {
              text: `result: ${stepName}`,
              toolCalls: [],
              runId: 'run-1',
              model: 'test-model',
              message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
              messages: [],
              stopReason: 'end_turn' as const,
              requests: [],
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
          },
        };
      }),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'parallel-test',
      description: 'Parallel test',
      steps: [
        { id: 'a', description: 'A', prompt: 'Do A', dependsOn: [] },
        { id: 'b', description: 'B', prompt: 'Do B', dependsOn: [] },
      ],
    };

    await engine.run(definition, {}, { workDir: '/tmp/test' });

    // A and B should overlap in time (parallel execution)
    const aStart = startTimes['A']!;
    const bStart = startTimes['B']!;
    const aEnd = endTimes['A']!;
    const bEnd = endTimes['B']!;

    // Both started before either finished = overlapped
    const overlapped = aStart < bEnd && bStart < aEnd;
    expect(overlapped).toBe(true);
  });

  it('resolves $steps.<id>.text variables', async () => {
    const mockSend = vi.fn(async (prompt: string, _opts: Record<string, unknown>) => ({
      text: prompt.includes('Summary from step A')
        ? 'Combined: summary-from-A + more'
        : 'summary-from-A',
      toolCalls: [],
      runId: 'run-1',
      model: 'test-model',
      message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
      messages: [],
      stopReason: 'end_turn' as const,
      requests: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }));

    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => ({
        id: `sess_${opts.title.split('/')[1]}`,
        title: opts.title,
        send: mockSend,
      })),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'var-test',
      description: 'Variable interpolation test',
      steps: [
        { id: 'a', description: 'Step A', prompt: 'Do A', dependsOn: [] },
        { id: 'b', description: 'Step B', prompt: 'Summary from step A: $steps.a.text', dependsOn: ['a'] },
      ],
    };

    const result = await engine.run(definition, {}, { workDir: '/tmp/test' });

    expect(result.steps[1]?.text).toContain('summary-from-A');
  });

  it('resolves $PARAM variables', async () => {
    const mockSend = vi.fn(async (_prompt: string, _opts: Record<string, unknown>) => ({
      text: 'Done',
      toolCalls: [],
      runId: 'run-1',
      model: 'test-model',
      message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
      messages: [],
      stopReason: 'end_turn' as const,
      requests: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }));

    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => ({
        id: `sess_${opts.title.split('/')[1]}`,
        title: opts.title,
        send: mockSend,
      })),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'param-test',
      description: 'Parameter test',
      steps: [
        { id: 'a', description: 'Step A', prompt: 'Check $REPO_PATH for issues in $BRANCH', dependsOn: [] },
      ],
    };

    await engine.run(
      definition,
      { REPO_PATH: '/home/user/project', BRANCH: 'main' },
      { workDir: '/tmp/test' },
    );

    const callPrompt = mockSend.mock.calls[0]?.[0];
    expect(callPrompt).toContain('/home/user/project');
    expect(callPrompt).toContain('main');
    expect(callPrompt).not.toContain('$REPO_PATH');
  });

  it('marks dependent steps as skipped when predecessor fails', async () => {
    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => {
        const stepName = opts.title.split('/')[1] ?? 'unknown';
        return {
          id: `sess_${stepName}`,
          title: opts.title,
          send: async (_prompt: string, _opts: Record<string, unknown>) => {
            if (stepName === 'A') throw new Error('Step A failed');
            return {
              text: `result: ${stepName}`,
              toolCalls: [],
              runId: 'run-1',
              model: 'test-model',
              message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
              messages: [],
              stopReason: 'end_turn' as const,
              requests: [],
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
          },
        };
      }),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'fail-test',
      description: 'Failure test',
      steps: [
        { id: 'a', description: 'A', prompt: 'Do A', dependsOn: [] },
        { id: 'b', description: 'B', prompt: 'Do B', dependsOn: ['a'] },
      ],
    };

    const result = await engine.run(definition, {}, { workDir: '/tmp/test' });

    const stepA = result.steps.find((s) => s.id === 'a')!;
    const stepB = result.steps.find((s) => s.id === 'b')!;

    expect(stepA.status).toBe('failed');
    expect(stepB.status).toBe('skipped');
    expect(result.status).toBe('failed');
  });

  it('skips only steps whose dependencies failed, not all subsequent steps', async () => {
    const executionOrder: string[] = [];
    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => {
        const stepName = opts.title.split('/')[1] ?? 'unknown';
        return {
          id: `sess_${stepName}`,
          title: opts.title,
          send: async (_prompt: string, _opts: Record<string, unknown>) => {
            executionOrder.push(stepName);
            if (stepName === 'A') throw new Error('Step A failed');
            return {
              text: `result: ${stepName}`,
              toolCalls: [],
              runId: 'run-1',
              model: 'test-model',
              message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
              messages: [],
              stopReason: 'end_turn' as const,
              requests: [],
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };
          },
        };
      }),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'mixed-fail-test',
      description: 'Mixed failure test',
      steps: [
        { id: 'a', description: 'A', prompt: 'Do A', dependsOn: [] },
        { id: 'c', description: 'C', prompt: 'Do C', dependsOn: [] },
        { id: 'b', description: 'B', prompt: 'Do B', dependsOn: ['a'] },
        { id: 'd', description: 'D', prompt: 'Do D', dependsOn: ['c'] },
      ],
    };

    const result = await engine.run(definition, {}, { workDir: '/tmp/test' });

    const stepA = result.steps.find((s) => s.id === 'a')!;
    const stepB = result.steps.find((s) => s.id === 'b')!;
    const stepC = result.steps.find((s) => s.id === 'c')!;
    const stepD = result.steps.find((s) => s.id === 'd')!;

    expect(stepA.status).toBe('failed');
    expect(stepB.status).toBe('skipped');    // depends on failed A
    expect(stepC.status).toBe('completed');  // same level as A, but independent
    expect(stepD.status).toBe('completed');  // depends on successful C
    expect(executionOrder).toContain('C');
    expect(executionOrder).toContain('D');
    expect(executionOrder).not.toContain('B');
    expect(result.status).toBe('partial');
  });

  it('emits workflow events via onEvent callback', async () => {
    const sdk = createMockSdk();
    const engine = new WorkflowEngine(sdk as never);
    const events: Array<{ type: string }> = [];

    const definition: WorkflowDefinition = {
      name: 'event-test',
      description: 'Event test',
      steps: [
        { id: 'a', description: 'Step A', prompt: 'Do A', dependsOn: [] },
      ],
    };

    await engine.run(definition, {}, {
      workDir: '/tmp/test',
      onEvent: (event) => events.push({ type: event.type }),
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('workflow.start');
    expect(eventTypes).toContain('step.start');
    expect(eventTypes).toContain('step.done');
    expect(eventTypes).toContain('workflow.done');
  });

  it('passes allowedTools as permission rules', async () => {
    const mockSend = vi.fn(async (_prompt: string, _opts: Record<string, unknown>) => ({
      text: 'Done',
      toolCalls: [],
      runId: 'run-1',
      model: 'test-model',
      message: { id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], model: 'test-model', stop_reason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5 } },
      messages: [],
      stopReason: 'end_turn' as const,
      requests: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }));

    const sdk = {
      config: { workDir: '/tmp/test' },
      createSession: vi.fn(async (opts: { title: string }) => ({
        id: `sess_${opts.title.split('/')[1]}`,
        title: opts.title,
        send: mockSend,
      })),
    };

    const engine = new WorkflowEngine(sdk as never);

    const definition: WorkflowDefinition = {
      name: 'tools-test',
      description: 'Tool test',
      steps: [
        {
          id: 'a',
          description: 'Step A',
          prompt: 'Do A',
          dependsOn: [],
          allowedTools: ['read', 'write'],
        },
      ],
    };

    await engine.run(definition, {}, { workDir: '/tmp/test' });

    const callOpts = mockSend.mock.calls[0]?.[1] as Record<string, unknown>;
    const permissions = callOpts?.permissions as Array<{
      toolName: string;
      behavior: string;
    }>;
    expect(permissions).toHaveLength(2);
    expect(permissions[0]?.toolName).toBe('read');
    expect(permissions[0]?.behavior).toBe('allow');
    expect(permissions[1]?.toolName).toBe('write');
  });
});
