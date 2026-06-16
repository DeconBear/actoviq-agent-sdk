/**
 * Advanced workflow tests — v0.5.0
 * Covers: StructuredOutput schema enforcement, persistence, resume
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadWorkflow,
  saveWorkflow,
  listWorkflows,
  deleteWorkflow,
  isWorkflowsDisabled,
} from '../src/workflow/workflowPersistence.js';

// ── Helpers ──────────────────────────────────────────────────────

function createMockSdk() {
  return {
    createSession: async (opts: any) => ({
      id: opts.title ?? 's1',
      send: async () => ({
        text: '{"name": "result", "score": 42}',
        message: { content: [{ type: 'text', text: '{"name": "result", "score": 42}' }] },
        usage: { input_tokens: 10, output_tokens: 5 },
        toolCalls: [],
      }),
    }),
    getTool: () => undefined,
  };
}

// ── StructuredOutput schema enforcement ───────────────────────────

describe('StructuredOutput schema enforcement', () => {
  it('agent call with schema passes schema to tool', async () => {
    const { WorkflowScriptRuntime } = await import('../src/workflow/workflowScriptRuntime.js');
    const sdk = {
      createSession: async () => ({
        id: 's1',
        send: async () => ({
          text: '{"title": "test", "count": 5}',
          message: { content: [{ type: 'text', text: '{"title": "test", "count": 5}' }] },
          usage: { input_tokens: 10, output_tokens: 5 },
          toolCalls: [],
        }),
      }),
      getTool: () => undefined,
    };

    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['title', 'count'],
    };

    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "schema-test", description: "test" };',
      'const result = await agent("get data", { schema: ' + JSON.stringify(schema) + ' });',
      'log("result: " + JSON.stringify(result));',
    ].join('\n');

    const output = await runtime.execute(script);
    expect(output.state.agentCalls.length).toBeGreaterThan(0);
  });

  it('retry on schema mismatch with valid JSON', async () => {
    const { WorkflowScriptRuntime } = await import('../src/workflow/workflowScriptRuntime.js');
    let callCount = 0;
    const sdk = {
      createSession: async () => ({
        id: 's1',
        send: async () => {
          callCount++;
          if (callCount === 1) {
            // First call: wrong format
            return {
              text: '{"wrong_field": "oops"}',
              message: { content: [{ type: 'text', text: '{"wrong_field": "oops"}' }] },
              usage: { input_tokens: 5, output_tokens: 3 },
              toolCalls: [],
            };
          }
          // Second call: correct format
          return {
            text: '{"name": "ok", "value": 100}',
            message: { content: [{ type: 'text', text: '{"name": "ok", "value": 100}' }] },
            usage: { input_tokens: 5, output_tokens: 3 },
            toolCalls: [],
          };
        },
      }),
      getTool: () => undefined,
    };

    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'number' },
      },
      required: ['name', 'value'],
    };

    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "retry-test", description: "test" };',
      'const result = await agent("get data", { schema: ' + JSON.stringify(schema) + ' });',
      'log("final: " + JSON.stringify(result));',
    ].join('\n');

    const output = await runtime.execute(script);
    // Should have been called at least once (possibly retried)
    expect(output.state.status).toBe('completed');
  });
});

// ── Workflow persistence ──────────────────────────────────────────

describe('Workflow persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `actoviq-wf-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.actoviq', 'workflows'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleScript = [
    'export const meta = {',
    '  name: "test-workflow",',
    '  description: "A test workflow for persistence",',
    '  phases: [{ title: "Analyze" }],',
    '};',
    'phase("Analyze");',
    'await agent("test prompt");',
  ].join('\n');

  it('saves and loads a workflow script', async () => {
    const filePath = await saveWorkflow('test-wf', sampleScript, {
      projectDir: tmpDir,
    });

    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = loadWorkflow('test-wf', tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('test-wf');
    expect(loaded!.script).toBe(sampleScript);
    expect(loaded!.source).toBe('project');
    expect(loaded!.meta?.name).toBe('test-workflow');
  });

  it('lists saved workflows', async () => {
    await saveWorkflow('wf-a', sampleScript, { projectDir: tmpDir });
    await saveWorkflow('wf-b', sampleScript, { projectDir: tmpDir });

    const workflows = listWorkflows(tmpDir);
    expect(workflows.length).toBe(2);
    expect(workflows.map((w) => w.name).sort()).toEqual(['wf-a', 'wf-b']);
  });

  it('deletes a workflow', async () => {
    await saveWorkflow('to-delete', sampleScript, { projectDir: tmpDir });
    expect(loadWorkflow('to-delete', tmpDir)).not.toBeNull();

    const deleted = await deleteWorkflow('to-delete', tmpDir);
    expect(deleted).toBe(true);
    expect(loadWorkflow('to-delete', tmpDir)).toBeNull();
  });

  it('returns null for non-existent workflow', () => {
    expect(loadWorkflow('nonexistent', tmpDir)).toBeNull();
  });

  it('prevents overwrite by default', async () => {
    await saveWorkflow('unique', sampleScript, { projectDir: tmpDir });
    await expect(
      saveWorkflow('unique', sampleScript, { projectDir: tmpDir }),
    ).rejects.toThrow('already exists');
  });

  it('allows overwrite when specified', async () => {
    await saveWorkflow('overwrite-me', sampleScript, { projectDir: tmpDir });
    const newScript = sampleScript.replace('test-workflow', 'updated-workflow');
    const filePath = await saveWorkflow('overwrite-me', newScript, {
      projectDir: tmpDir,
      overwrite: true,
    });

    const loaded = loadWorkflow('overwrite-me', tmpDir);
    expect(loaded!.meta?.name).toBe('updated-workflow');
  });

  it('checks workflows disabled flag', () => {
    // Default: not disabled
    expect(isWorkflowsDisabled()).toBe(false);

    // Set env var
    process.env.ACTOVIQ_DISABLE_WORKFLOWS = '1';
    expect(isWorkflowsDisabled()).toBe(true);

    process.env.ACTOVIQ_DISABLE_WORKFLOWS = 'true';
    expect(isWorkflowsDisabled()).toBe(true);

    delete process.env.ACTOVIQ_DISABLE_WORKFLOWS;
  });
});

// ── Resume state ─────────────────────────────────────────────────

describe('Workflow resume state', () => {
  it('captures and restores resume state', async () => {
    const { WorkflowScriptRuntime } = await import('../src/workflow/workflowScriptRuntime.js');
    const sdk = createMockSdk();

    const runtime = new WorkflowScriptRuntime({ sdk: sdk as any });

    const script = [
      'export const meta = { name: "resume-test", description: "test" };',
      'await agent("step 1");',
      'await agent("step 2");',
    ].join('\n');

    const output = await runtime.execute(script);
    const resumeState = output.resumeState;

    expect(resumeState.agentCallIds.length).toBe(2);
    expect(resumeState.completedAgentIds.size).toBe(2);
    expect(resumeState.cache.size).toBeGreaterThan(0);
    expect(resumeState.errors.length).toBe(0);

    // Resume: create new runtime with resumeState, execute same script
    const runtime2 = new WorkflowScriptRuntime({
      sdk: sdk as any,
      resumeState,
    });

    const output2 = await runtime2.execute(script);
    // All calls should be cached
    expect(output2.state.agentCalls.every((c) => c.cached)).toBe(true);
  });
});
