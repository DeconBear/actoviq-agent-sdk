import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CapabilityError,
  RunError,
  UsageAccumulator,
  assertJsonValue,
  cloneJsonValue,
  isJsonValue,
  type AgentSpec,
  type CanonicalItem,
  type JsonValue,
  type RunContext,
  type RunResult,
} from '../src/core/index.js';

describe('core canonical contracts', () => {
  it('round-trips text, image, tool, reasoning, and raw items through JSON', () => {
    const items: CanonicalItem[] = [
      { type: 'text', role: 'system', text: 'Be precise.' },
      { type: 'text', role: 'user', text: 'Inspect this image.' },
      {
        type: 'image',
        role: 'user',
        source: { kind: 'url', url: 'https://example.test/chart.png' },
        detail: 'high',
      },
      {
        type: 'image',
        role: 'user',
        source: { kind: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
      },
      {
        type: 'image',
        role: 'assistant',
        source: { kind: 'file', fileId: 'artifact_image_1' },
      },
      {
        type: 'audio',
        role: 'user',
        source: { kind: 'base64', mediaType: 'audio/wav', data: 'UklGRg==' },
        transcript: 'hello',
      },
      {
        type: 'document',
        role: 'user',
        source: { kind: 'file', fileId: 'file_report_1' },
        name: 'report.pdf',
        mediaType: 'application/pdf',
      },
      {
        type: 'artifact_ref',
        artifactId: 'artifact_large_result_1',
        name: 'analysis.json',
        mediaType: 'application/json',
      },
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'README.md', line: 7 },
      },
      {
        type: 'tool_result',
        callId: 'call_1',
        name: 'read_file',
        status: 'success',
        output: { text: 'hello', truncated: false },
      },
      {
        type: 'handoff_call',
        id: 'handoff_1',
        targetAgentId: 'reviewer',
        input: { task: 'Review the evidence.' },
      },
      {
        type: 'handoff_result',
        callId: 'handoff_1',
        targetAgentId: 'reviewer',
        status: 'success',
        output: { approved: true },
      },
      {
        type: 'reasoning',
        id: 'reasoning_1',
        provider: 'fixture',
        summary: 'Checked the available evidence.',
        opaque: {
          encrypted: 'opaque-provider-payload',
          signature: ['part-a', 'part-b'],
        },
      },
      {
        type: 'raw',
        id: 'raw_1',
        provider: 'fixture',
        value: {
          future_item: { nested: [1, true, null] },
        },
      },
      {
        type: 'structured',
        role: 'assistant',
        schemaName: 'answer',
        value: { answer: '42', confidence: 0.99 },
      },
      {
        type: 'refusal',
        role: 'assistant',
        message: 'The request is outside policy.',
        providerData: { category: 'policy' },
      },
      {
        type: 'error',
        source: 'tool',
        code: 'READ_FAILED',
        message: 'The file could not be read.',
        retryable: false,
        callId: 'call_2',
        details: { path: 'missing.txt' },
      },
      { type: 'text', role: 'assistant', text: 'Done.' },
    ];

    const serialized = JSON.stringify(items);
    const restored = JSON.parse(serialized) as CanonicalItem[];

    expect(restored).toEqual(items);
    expect(serialized).not.toContain('stop_reason');
    expect(serialized).not.toContain('max_tokens');
    expect(serialized).not.toContain('tool_use_id');
    expect(serialized).not.toContain('input_schema');
    expect(serialized).not.toContain('cache_creation_input_tokens');
    expect(restored.map(item => item.type)).toEqual([
      'text',
      'text',
      'image',
      'image',
      'image',
      'audio',
      'document',
      'artifact_ref',
      'tool_call',
      'tool_result',
      'handoff_call',
      'handoff_result',
      'reasoning',
      'raw',
      'structured',
      'refusal',
      'error',
      'text',
    ]);
    expect(restored.find(item => item.type === 'reasoning')).toEqual(
      items.find(item => item.type === 'reasoning'),
    );
    expect(restored.find(item => item.type === 'raw')).toEqual(
      items.find(item => item.type === 'raw'),
    );
  });

  it('accepts only lossless finite JSON values at persistence boundaries', () => {
    const value = {
      scalar: 'value',
      nested: [1, true, null, { key: 'child' }],
    } satisfies JsonValue;

    expect(isJsonValue(value)).toBe(true);
    expect(cloneJsonValue(value)).toEqual(value);

    expect(isJsonValue({ value: Number.NaN })).toBe(false);
    expect(isJsonValue({ value: undefined })).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);

    const sparse = new Array(2) as unknown[];
    sparse[1] = 'present';
    expect(isJsonValue(sparse)).toBe(false);

    const arrayWithDroppedProperty = ['value'] as string[] & { extra?: string };
    arrayWithDroppedProperty.extra = 'not serialized';
    expect(isJsonValue(arrayWithDroppedProperty)).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
    expect(() => assertJsonValue(cyclic, 'checkpoint')).toThrow(
      'checkpoint must be a finite, acyclic JSON value.',
    );
  });
});

describe('core agent and run contracts', () => {
  it('preserves context and structured-output generics', async () => {
    type Context = { readonly tenantId: string };
    type Output = { readonly answer: string; readonly confidence: number };

    const agent: AgentSpec<Context, Output> = {
      id: 'researcher',
      name: 'Researcher',
      instructions: context => `Tenant: ${context.context.tenantId}`,
      model: { provider: 'fixture', model: 'model-a' },
      output: {
        name: 'research_answer',
        schema: {
          type: 'object',
          required: ['answer', 'confidence'],
        },
        parse: value => value as Output,
      },
      metadata: { profile: 'research' },
    };

    const context: RunContext<Context> = {
      runId: 'run_1',
      agentId: agent.id,
      context: { tenantId: 'tenant-a' },
      signal: new AbortController().signal,
      startedAt: '2026-07-11T00:00:00.000Z',
      deadlineAt: '2026-07-11T00:15:00.000Z',
      metadata: {},
      usage: new UsageAccumulator(),
    };

    expect(typeof agent.instructions).toBe('function');
    if (typeof agent.instructions === 'function') {
      expect(await agent.instructions(context)).toBe('Tenant: tenant-a');
    }
    expectTypeOf(agent).toMatchTypeOf<AgentSpec<Context, Output>>();

    const result: RunResult<Output> = {
      runId: context.runId,
      agentId: agent.id,
      status: 'completed',
      output: { answer: '42', confidence: 0.99 },
      items: [{ type: 'text', role: 'assistant', text: '42' }],
      usage: context.usage.snapshot(),
      startedAt: context.startedAt,
      completedAt: '2026-07-11T00:00:01.000Z',
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expectTypeOf(result.output).toEqualTypeOf<Output>();
  });

  it('provides structured run and capability errors without provider inference', () => {
    const cause = new Error('fixture transport detail');
    const error = new CapabilityError('Model does not support images.', {
      providerId: 'fixture-provider',
      model: 'text-only',
      capability: 'vision',
      cause,
    });

    expect(error).toBeInstanceOf(RunError);
    expect(error.code).toBe('CAPABILITY_ERROR');
    expect(error.providerId).toBe('fixture-provider');
    expect(error.model).toBe('text-only');
    expect(error.capability).toBe('vision');
    expect(error.cause).toBe(cause);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'CapabilityError',
      message: 'Model does not support images.',
      code: 'CAPABILITY_ERROR',
      phase: 'model_call',
      retryable: false,
      details: {
        providerId: 'fixture-provider',
        model: 'text-only',
        capability: 'vision',
      },
    });
  });
});
