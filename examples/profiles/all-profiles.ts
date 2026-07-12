import type { ModelRef, Usage } from '../../src/core/index.js';
import {
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  mergeModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ResolvedModel,
} from '../../src/providers-v2/index.js';
import { AGENT_PROFILE_KINDS, buildProfile, runProfile } from '../../src/profiles/index.js';
import {
  AgentRuntime,
  MiddlewareRegistry,
  MiddlewareStage,
  RuntimeServices,
  ToolRegistry,
  defineMiddleware,
  type RuntimeTool,
} from '../../src/runtime-v2/index.js';

const profiles = AGENT_PROFILE_KINDS.map(kind => buildProfile(kind, {
  model: 'example:model',
}));
const toolNames = new Set(profiles.flatMap(profile => profile.config.dependencies.requiredTools
  .map(ref => typeof ref === 'string' ? ref : ref.id)));
const middlewareNames = new Set(profiles.flatMap(profile => profile.config.dependencies.requiredMiddleware
  .map(ref => typeof ref === 'string' ? ref : ref.id)));
const serviceNames = new Set(profiles.flatMap(profile => profile.config.dependencies.requiredServices));

async function main(): Promise<void> {
  const middlewareRegistry = new MiddlewareRegistry(Object.fromEntries(
    [...middlewareNames].map((id, index) => [id, defineMiddleware({
      name: id,
      stage: MiddlewareStage.BeforeRun,
      priority: 1_000 + index,
      handle: (_context, next) => next(),
    })]),
  ));
  const runtime = new AgentRuntime({
    models: new ModelRegistry([new ExampleProvider()]),
    tools: new ToolRegistry([...toolNames].map(exampleTool)),
    middlewareRegistry,
    services: new RuntimeServices(Object.fromEntries(
      [...serviceNames].map(id => [id, { factory: () => ({ close: () => undefined }) }]),
    )),
  });

  try {
    for (const profile of profiles) {
      const result = await runProfile(runtime, profile, `Demonstrate the ${profile.kind} profile.`, {
        workspaceId: profile.config.workspace.required ? 'example-workspace' : undefined,
      });
      process.stdout.write(`${profile.kind}: ${result.output}\n`);
    }
  } finally {
    await runtime.close();
  }
}

class ExampleProvider implements ModelProvider {
  readonly id = 'example';

  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    const model = typeof ref === 'string' ? ref.replace(/^example:/, '') : ref.model;
    return { providerId: this.id, modelId: model, ref: { provider: this.id, model } };
  }

  async capabilities() {
    return mergeModelCapabilities(MINIMAL_MODEL_CAPABILITIES, { tools: { function: true } });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = typeof request.model === 'object' && 'providerId' in request.model
      ? request.model
      : await this.resolve(request.model);
    const profile = request.input.find(item => item.type === 'text' && item.role === 'system');
    return {
      id: `example-${model.modelId}`,
      model,
      output: [{
        type: 'text',
        role: 'assistant',
        text: profile?.type === 'text' ? profile.text.slice(0, 48) : 'ok',
      }],
      finishReason: 'stop',
      usage: zeroUsage(),
    };
  }

  stream(): never {
    throw new Error('This deterministic example uses run(), not stream().');
  }
}

function exampleTool(name: string): RuntimeTool {
  return {
    descriptor: {
      name,
      description: `Example placeholder for ${name}.`,
      input: { parse: value => value, jsonSchema: { type: 'object' } },
      behavior: { effect: 'read' },
    },
    execute: () => ({ available: true }),
  };
}

function zeroUsage(): Usage {
  return {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
  };
}

await main();
