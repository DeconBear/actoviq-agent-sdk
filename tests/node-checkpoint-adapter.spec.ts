import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSpec } from '../src/core/index.js';
import { SqliteRunCheckpointAdapter, SqliteStorageV2 } from '../src/node/index.js';
import {
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  mergeModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStream,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import { AgentRuntime, ToolRegistry, type RuntimeTool } from '../src/runtime-v2/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const capabilities = mergeModelCapabilities(MINIMAL_MODEL_CAPABILITIES, {
  tools: { function: true },
});

class ApprovalProvider implements ModelProvider {
  readonly id = 'fake';
  calls = 0;

  async resolve(): Promise<ResolvedModel> {
    return { providerId: 'fake', modelId: 'model', ref: { provider: 'fake', model: 'model' } };
  }

  async capabilities() {
    return capabilities;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const model = await this.resolve();
    return this.calls === 1
      ? {
          id: 'first', model, finishReason: 'tool_calls',
          output: [{ type: 'tool_call', id: 'deploy-1', name: 'deploy', input: { target: 'staging' } }],
          usage: zeroUsage(),
        }
      : {
          id: 'second', model, finishReason: 'stop',
          output: [{ type: 'text', role: 'assistant', text: 'deployed' }],
          usage: zeroUsage(),
        };
  }

  stream(request: ModelRequest): ModelStream {
    const final = this.generate(request);
    return {
      cancel: () => undefined,
      finalResponse: () => final,
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.completed' as const, response: await final };
      },
    };
  }
}

function zeroUsage() {
  return {
    requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    audioInputTokens: 0, audioOutputTokens: 0, costUsd: 0,
  };
}

describe('SqliteRunCheckpointAdapter', () => {
  it('survives runtime/storage restart at approval and resumes a side effect exactly once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-checkpoint-e2e-'));
    roots.push(root);
    const filename = path.join(root, 'runtime.sqlite');
    const provider = new ApprovalProvider();
    const execute = vi.fn(() => ({ deploymentId: 'dep-1' }));
    const deploy: RuntimeTool<unknown, { target: string }, { deploymentId: string }> = {
      descriptor: {
        name: 'deploy', description: 'Deploy an application.',
        input: { parse: value => value as { target: string }, jsonSchema: { type: 'object' } },
        behavior: { effect: 'side-effect', requiresApproval: true },
      },
      execute,
    };
    const agent: AgentSpec = {
      id: 'deployer', name: 'Deployer', instructions: 'Deploy safely.',
      model: 'fake:model', tools: ['deploy'],
    };

    const firstStorage = await SqliteStorageV2.open({ filename });
    const firstAdapter = new SqliteRunCheckpointAdapter({
      store: firstStorage.checkpoints, tenantId: 'tenant-a',
    });
    const firstRuntime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      tools: new ToolRegistry([deploy]),
      checkpointStore: firstAdapter,
    });
    const firstHandle = firstRuntime.stream(agent, 'deploy');
    await expect(firstHandle.result).resolves.toMatchObject({ status: 'interrupted' });
    const inMemoryState = await firstHandle.snapshot();
    expect(execute).not.toHaveBeenCalled();
    await firstRuntime.close();
    await firstStorage.close();

    // Re-open every live object, as a process restart would.
    const secondStorage = await SqliteStorageV2.open({ filename });
    const secondAdapter = new SqliteRunCheckpointAdapter({
      store: secondStorage.checkpoints, tenantId: 'tenant-a',
    });
    const durableState = await secondAdapter.load(inMemoryState.runId);
    expect(durableState).toMatchObject({
      runId: inMemoryState.runId,
      status: 'interrupted',
      pendingTool: { status: 'awaiting_approval', effect: 'side-effect' },
    });

    const secondRuntime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      tools: new ToolRegistry([deploy]),
      checkpointStore: secondAdapter,
      agents: [agent],
    });
    const resumed = secondRuntime.resume(durableState!, [{
      interruptionId: durableState?.pendingTool?.interruptionId ?? '', outcome: 'approve',
    }]);
    await expect(resumed.result).resolves.toMatchObject({ status: 'completed', output: 'deployed' });
    expect(execute).toHaveBeenCalledTimes(1);

    const completed = await secondAdapter.load(inMemoryState.runId);
    expect(completed?.status).toBe('completed');
    await secondRuntime.close();
    await secondStorage.close();
  });
});
