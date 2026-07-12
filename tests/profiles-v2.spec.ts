import { describe, expect, it, vi } from 'vitest';

import type { JsonObject, ModelRef, Usage } from '../src/core/index.js';
import {
  MINIMAL_MODEL_CAPABILITIES,
  ModelRegistry,
  mergeModelCapabilities,
  type ModelCallContext,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ResolvedModel,
} from '../src/providers-v2/index.js';
import {
  AGENT_PROFILE_KINDS,
  assertProfileRuntime,
  buildProfile,
  inspectProfile,
  runProfile,
} from '../src/profiles/index.js';
import {
  AgentRuntime,
  MiddlewareRegistry,
  MiddlewareStage,
  RuntimeServices,
  ToolRegistry,
  defineMiddleware,
  type RuntimeTool,
} from '../src/runtime-v2/index.js';

const CAPABILITIES = mergeModelCapabilities(MINIMAL_MODEL_CAPABILITIES, {
  tools: { function: true, parallel: true },
});

const FAKE_MODEL: ResolvedModel = {
  providerId: 'profile-fake',
  modelId: 'model',
  ref: { provider: 'profile-fake', model: 'model' },
};

class ProfileFakeProvider implements ModelProvider {
  readonly id = 'profile-fake';
  readonly requests: ModelRequest[] = [];

  async resolve(ref: ModelRef): Promise<ResolvedModel> {
    const modelId = typeof ref === 'string'
      ? ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref
      : ref.model;
    return { providerId: this.id, modelId, ref: { provider: this.id, model: modelId } };
  }

  async capabilities() {
    return CAPABILITIES;
  }

  async generate(request: ModelRequest, _context: ModelCallContext): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      id: `profile-response-${this.requests.length}`,
      model: FAKE_MODEL,
      output: [{
        type: 'text',
        role: 'assistant',
        text: `profile-${this.requests.length}`,
      }],
      finishReason: 'stop',
      usage: usage(),
    };
  }

  stream(): never {
    throw new Error('Profile acceptance uses the same generate contract.');
  }
}

describe('composable agent profiles', () => {
  it('runs all six profiles through one AgentRuntime and one provider contract', async () => {
    const profiles = AGENT_PROFILE_KINDS.map(kind => buildProfile(kind, {
      model: 'profile-fake:model',
    }));
    const requiredToolNames = new Set(profiles.flatMap(profile => (
      profile.config.dependencies.requiredTools.map(ref => typeof ref === 'string' ? ref : ref.id)
    )));
    const tools = new ToolRegistry([...requiredToolNames].map(fakeTool));
    const middlewareIds = new Set(profiles.flatMap(profile => (
      profile.config.dependencies.requiredMiddleware.map(ref => typeof ref === 'string' ? ref : ref.id)
    )));
    const middlewareRegistry = new MiddlewareRegistry(Object.fromEntries(
      [...middlewareIds].map((id, index) => [id, defineMiddleware({
        name: id,
        stage: MiddlewareStage.BeforeRun,
        priority: 1_000 + index,
        handle: (_context, next) => next(),
      })]),
    ));
    const serviceFactories = Object.fromEntries(
      [...new Set(profiles.flatMap(profile => profile.config.dependencies.requiredServices))]
        .map(id => [id, { factory: vi.fn(() => ({})) }]),
    );
    const services = new RuntimeServices(serviceFactories);
    const provider = new ProfileFakeProvider();
    const runtime = new AgentRuntime({
      models: new ModelRegistry([provider]),
      tools,
      services,
      middlewareRegistry,
    });

    const results = [];
    for (const profile of profiles) {
      results.push(await runProfile(runtime, profile, `run ${profile.kind}`, {
        workspaceId: profile.config.workspace.required ? 'acceptance-workspace' : undefined,
      }));
    }

    expect(results.map(result => result.agentId)).toEqual(profiles.map(profile => profile.spec.id));
    expect(results.map(result => result.output)).toEqual([
      'profile-1',
      'profile-2',
      'profile-3',
      'profile-4',
      'profile-5',
      'profile-6',
    ]);
    expect(provider.requests).toHaveLength(6);
    expect(new Set(provider.requests.map(request => (
      typeof request.model === 'string' ? request.model : 'providerId' in request.model
        ? request.model.providerId
        : request.model.provider
    )))).toEqual(new Set(['profile-fake']));
    await runtime.close();
  });

  it('makes the coding workspace and permission boundary explicit', () => {
    const profile = inspectProfile(buildProfile('coding'));

    expect(profile.config.workspace).toEqual({
      required: true,
      access: 'read-write',
      containment: 'workspace-root',
      symlinkEscape: 'deny',
      resumePolicy: 'same-workspace',
    });
    expect(profile.config.dependencies.requiredServices).toContain('workspace');
    expect(refIds(profile.config.dependencies.requiredMiddleware)).toEqual(
      expect.arrayContaining(['policy.permissions', 'workspace.boundary']),
    );
    expect(refIds(profile.config.dependencies.requiredTools)).toEqual(
      expect.arrayContaining(['workspace.read', 'workspace.write']),
    );
    expect(profile.config.security).toMatchObject({
      permissionPolicyRef: 'policy.permissions',
      sideEffects: 'approval-or-policy',
      childPolicy: 'inherit-stricter',
    });
  });

  it('declares research artifact and citation result metadata', () => {
    const profile = buildProfile('research');
    const metadata = profile.spec.metadata?.actoviqProfile as JsonObject;
    const result = metadata.result as JsonObject;

    expect(profile.config.dependencies.requiredServices).toContain('artifacts');
    expect(refIds(profile.config.dependencies.requiredTools)).toEqual(
      expect.arrayContaining(['research.search', 'artifacts.write']),
    );
    expect(profile.config.result).toEqual({
      artifacts: 'required',
      citations: 'required',
      citationsMetadataKey: 'citations',
      artifactItemType: 'artifact_ref',
    });
    expect(result).toMatchObject({
      citations: 'required',
      citationsMetadataKey: 'citations',
      artifactItemType: 'artifact_ref',
    });
  });

  it('selects deterministic WorkflowGraph and reducer composition without embedding an engine', () => {
    const profile = buildProfile('workflow');

    expect(profile.config.orchestration).toMatchObject({
      mode: 'workflow',
      refs: ['WorkflowGraph', 'workflow.reducer'],
      deterministic: true,
      reducerRequired: true,
      durable: false,
      checkpointServiceId: 'checkpoints',
    });
    expect(profile.config.dependencies.requiredServices).toContain('checkpoints');
    expect(refIds(profile.config.dependencies.requiredMiddleware)).toContain('workflow.determinism');
  });

  it('caps supervisor child budget and requires stricter inherited policy', () => {
    const profile = buildProfile('supervisor', {
      limits: {
        maxSubagentDepth: 2,
        maxSubagentFanout: 3,
        maxTotalTokens: 250_000,
        maxCostUsd: 20,
      },
    });

    expect(profile.config.orchestration).toMatchObject({
      mode: 'supervisor',
      refs: ['ChildRunner', 'agentAsTool', 'createHandoff'],
      childFailurePolicy: 'fail-fast',
      childBudget: {
        maxChildRuns: 3,
        maxDepth: 2,
        maxTotalTokens: 250_000,
        maxCostUsd: 20,
      },
    });
    expect(profile.config.security.childPolicy).toBe('inherit-stricter');
    expect(profile.config.dependencies.requiredServices).toContain('orchestration');
    expect(refIds(profile.config.dependencies.requiredTools)).toContain('agent.spawn');
  });

  it('requires durable background checkpoint services and reconciliation policy', () => {
    const profile = buildProfile('background');

    expect(profile.config.dependencies.requiredServices).toEqual(
      expect.arrayContaining(['checkpoints', 'background']),
    );
    expect(refIds(profile.config.dependencies.requiredMiddleware)).toContain('background.checkpoint');
    expect(profile.config.orchestration).toMatchObject({
      mode: 'background',
      refs: ['BackgroundChildManager', 'DurableChildStore'],
      durable: true,
      checkpointServiceId: 'checkpoints',
      childFailurePolicy: 'fail-fast',
    });
    expect(profile.spec.instructions).toContain('idempotent');
  });

  it('keeps chat minimal and enables memory, skills, and compaction only by opt-in', () => {
    const minimal = buildProfile('chat');
    expect(minimal.spec.tools).toBeUndefined();
    expect(minimal.spec.middleware).toBeUndefined();
    expect(minimal.config.dependencies.requiredServices).toEqual([]);
    expect(minimal.config.optIns).toEqual({ memory: false, skills: false, compaction: false });

    const composed = buildProfile('chat', {
      optIns: { memory: true, skills: true, compaction: true },
    });
    expect(composed.config.dependencies.requiredServices).toEqual([
      'memory',
      'skills',
      'compaction',
    ]);
    expect(refIds(composed.spec.middleware ?? [])).toEqual([
      'profile.memory',
      'profile.skills',
      'profile.compaction',
    ]);
  });

  it('fails profile composition before a run when required abilities are absent', async () => {
    const runtime = new AgentRuntime({
      models: new ModelRegistry([new ProfileFakeProvider()]),
    });
    expect(() => assertProfileRuntime(buildProfile('coding'), runtime, {}))
      .toThrow(/services: workspace.*middleware: policy.permissions.*tools: workspace.read.*workspaceId/);
    await runtime.close();
  });

  it('clones caller data and returns a deeply immutable spec and config', () => {
    const metadata: JsonObject = { label: 'original', nested: { value: 1 } };
    const profile = buildProfile('chat', { metadata });
    (metadata.nested as { value: number }).value = 2;

    expect((profile.spec.metadata?.nested as JsonObject).value).toBe(1);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.spec)).toBe(true);
    expect(Object.isFrozen(profile.spec.metadata)).toBe(true);
    expect(Object.isFrozen(profile.config.dependencies.requiredServices)).toBe(true);
    expect(() => {
      (profile.config.limits as { maxTurns: number }).maxTurns = 100;
    }).toThrow(TypeError);
  });
});

function fakeTool(name: string): RuntimeTool<unknown, unknown, null> {
  return {
    descriptor: {
      name,
      description: `Acceptance placeholder for ${name}.`,
      input: { jsonSchema: { type: 'object' }, parse: value => value },
      behavior: { effect: 'read' },
    },
    execute: () => null,
  };
}

function refIds(refs: readonly (string | { readonly id: string })[]): string[] {
  return refs.map(ref => typeof ref === 'string' ? ref : ref.id);
}

function usage(): Usage {
  return {
    requests: 1,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0,
  };
}
