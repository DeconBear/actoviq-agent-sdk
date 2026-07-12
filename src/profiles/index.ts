import {
  cloneJsonValue,
  type AgentSpec,
  type HandoffRef,
  type InputGuardrail,
  type JsonObject,
  type MiddlewareRef,
  type ModelRef,
  type OutputGuardrail,
  type OutputSchema,
  type RunLimits,
  type ToolRef,
} from '../core/index.js';
import type { RuntimeServiceId } from '../runtime-v2/services.js';
import type {
  AgentInput,
  AgentRuntime,
  RunOptions,
} from '../runtime-v2/agentRuntime.js';

import {
  AGENT_PROFILE_KINDS,
  type AgentProfileConfig,
  type AgentProfileInspection,
  type AgentProfileKind,
  type BuildProfileOptions,
  type BuiltAgentProfile,
  type ProfileDependencies,
  type ProfileOptIns,
  type ProfileOrchestrationExpectation,
  type ProfileResultExpectation,
  type ProfileSecurityExpectation,
  type ProfileWorkspaceExpectation,
} from './types.js';

export * from './types.js';

interface ProfileDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly limits: RunLimits;
  readonly dependencies: ProfileDependencies;
  readonly workspace: ProfileWorkspaceExpectation;
  readonly security: ProfileSecurityExpectation;
  readonly result: ProfileResultExpectation;
  readonly orchestration: ProfileOrchestrationExpectation;
}

const OPT_IN_SERVICE_REFS = Object.freeze({
  memory: 'memory',
  skills: 'skills',
  compaction: 'compaction',
} satisfies Record<keyof Required<ProfileOptIns>, RuntimeServiceId>);

const OPT_IN_MIDDLEWARE_REFS = Object.freeze({
  memory: 'profile.memory',
  skills: 'profile.skills',
  compaction: 'profile.compaction',
} satisfies Record<keyof Required<ProfileOptIns>, MiddlewareRef>);

const OPTIONAL_SERVICES = Object.freeze(Object.values(OPT_IN_SERVICE_REFS));
const OPTIONAL_MIDDLEWARE = Object.freeze(Object.values(OPT_IN_MIDDLEWARE_REFS));

const PROFILE_DEFINITIONS: Readonly<Record<AgentProfileKind, ProfileDefinition>> = deepFreeze({
  chat: {
    id: 'chat-agent',
    name: 'Chat Agent',
    description: 'A minimal conversational agent with no optional runtime ability enabled.',
    instructions: 'Answer the user clearly and directly. Do not claim access to tools or data that were not provided.',
    limits: {
      maxTurns: 8,
      runDeadlineMs: 300_000,
      modelCallTimeoutMs: 90_000,
      toolTimeoutMs: 30_000,
      hookTimeoutMs: 10_000,
      maxParallelTools: 1,
      maxSubagentDepth: 1,
      maxSubagentFanout: 1,
      streamBufferSize: 128,
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      maxTotalTokens: 192_000,
      maxCostUsd: 10,
    },
    dependencies: dependencies([], [], []),
    workspace: noWorkspace(),
    security: {
      sideEffects: 'deny-by-default',
      network: 'disabled',
      process: 'disabled',
      childPolicy: 'none',
      secrets: 'runtime-service-only',
    },
    result: { artifacts: 'none', citations: 'none' },
    orchestration: noOrchestration(),
  },
  coding: {
    id: 'coding-agent',
    name: 'Coding Agent',
    description: 'A workspace-contained coding agent whose writes pass through runtime policy.',
    instructions: [
      'Work only inside the provided workspace.',
      'Inspect before editing, keep changes scoped to the request, and verify relevant behavior.',
      'Use registered workspace tools; writes, process execution, and network access remain subject to runtime policy.',
    ].join(' '),
    limits: {
      maxTurns: 96,
      runDeadlineMs: 3_600_000,
      modelCallTimeoutMs: 180_000,
      toolTimeoutMs: 120_000,
      hookTimeoutMs: 30_000,
      maxParallelTools: 4,
      maxSubagentDepth: 2,
      maxSubagentFanout: 4,
      streamBufferSize: 256,
      maxInputTokens: 512_000,
      maxOutputTokens: 32_768,
      maxTotalTokens: 768_000,
      maxCostUsd: 50,
    },
    dependencies: dependencies(
      ['workspace'],
      ['policy.permissions', 'workspace.boundary'],
      ['workspace.read', 'workspace.write'],
      ['workspace.shell', 'workspace.test', 'workspace.git'],
    ),
    workspace: {
      required: true,
      access: 'read-write',
      containment: 'workspace-root',
      symlinkEscape: 'deny',
      resumePolicy: 'same-workspace',
    },
    security: {
      permissionPolicyRef: 'policy.permissions',
      sideEffects: 'approval-or-policy',
      network: 'policy-controlled',
      process: 'policy-controlled',
      childPolicy: 'inherit-stricter',
      secrets: 'runtime-service-only',
    },
    result: { artifacts: 'optional', citations: 'none', artifactItemType: 'artifact_ref' },
    orchestration: noOrchestration(),
  },
  research: {
    id: 'research-agent',
    name: 'Research Agent',
    description: 'A source-oriented research agent that records citations and durable artifact references.',
    instructions: [
      'Research the question using only registered sources.',
      'Distinguish sourced facts from inference, preserve citation metadata, and return large outputs as artifact references.',
    ].join(' '),
    limits: {
      maxTurns: 24,
      runDeadlineMs: 1_200_000,
      modelCallTimeoutMs: 180_000,
      toolTimeoutMs: 180_000,
      hookTimeoutMs: 30_000,
      maxParallelTools: 8,
      maxSubagentDepth: 2,
      maxSubagentFanout: 6,
      streamBufferSize: 256,
      maxInputTokens: 768_000,
      maxOutputTokens: 32_768,
      maxTotalTokens: 1_000_000,
      maxCostUsd: 75,
    },
    dependencies: dependencies(
      ['artifacts'],
      ['research.citations'],
      ['research.search', 'artifacts.write'],
      ['research.fetch', 'research.crawl'],
    ),
    workspace: noWorkspace(),
    security: {
      permissionPolicyRef: 'policy.permissions',
      sideEffects: 'approval-or-policy',
      network: 'policy-controlled',
      process: 'disabled',
      childPolicy: 'inherit-stricter',
      secrets: 'runtime-service-only',
    },
    result: {
      artifacts: 'required',
      citations: 'required',
      citationsMetadataKey: 'citations',
      artifactItemType: 'artifact_ref',
    },
    orchestration: noOrchestration(),
  },
  workflow: {
    id: 'workflow-agent',
    name: 'Workflow Agent',
    description: 'An AgentRuntime participant selected for deterministic WorkflowGraph composition.',
    instructions: [
      'Complete the assigned workflow node and return only the node contract requested by the graph.',
      'Do not choose graph order or retry policy; those decisions belong to the orchestration layer.',
    ].join(' '),
    limits: {
      maxTurns: 12,
      runDeadlineMs: 900_000,
      modelCallTimeoutMs: 120_000,
      toolTimeoutMs: 120_000,
      hookTimeoutMs: 30_000,
      maxParallelTools: 4,
      maxSubagentDepth: 2,
      maxSubagentFanout: 8,
      streamBufferSize: 256,
      maxInputTokens: 384_000,
      maxOutputTokens: 16_384,
      maxTotalTokens: 512_000,
      maxCostUsd: 40,
    },
    dependencies: dependencies(
      ['checkpoints'],
      ['orchestration.scope', 'workflow.determinism'],
      [],
      ['workflow.approval'],
    ),
    workspace: {
      required: false,
      access: 'inherited',
      containment: 'workspace-root',
      symlinkEscape: 'deny',
      resumePolicy: 'same-workspace',
    },
    security: {
      permissionPolicyRef: 'policy.permissions',
      sideEffects: 'approval-or-policy',
      network: 'policy-controlled',
      process: 'policy-controlled',
      childPolicy: 'inherit-stricter',
      secrets: 'runtime-service-only',
    },
    result: { artifacts: 'optional', citations: 'optional', artifactItemType: 'artifact_ref' },
    orchestration: {
      mode: 'workflow',
      refs: ['WorkflowGraph', 'workflow.reducer'],
      deterministic: true,
      reducerRequired: true,
      childFailurePolicy: 'fail-fast',
      durable: false,
      checkpointServiceId: 'checkpoints',
    },
  },
  supervisor: {
    id: 'supervisor-agent',
    name: 'Supervisor Agent',
    description: 'A bounded coordinator that delegates through ChildRunner on the same AgentRuntime.',
    instructions: [
      'Delegate only when it improves the result, keep child work within the inherited budget, and synthesize child outcomes.',
      'Never relax the parent permission, deadline, workspace, tenant, or failure policy.',
    ].join(' '),
    limits: {
      maxTurns: 24,
      runDeadlineMs: 1_200_000,
      modelCallTimeoutMs: 120_000,
      toolTimeoutMs: 180_000,
      hookTimeoutMs: 30_000,
      maxParallelTools: 8,
      maxSubagentDepth: 3,
      maxSubagentFanout: 8,
      streamBufferSize: 512,
      maxInputTokens: 512_000,
      maxOutputTokens: 32_768,
      maxTotalTokens: 1_000_000,
      maxCostUsd: 100,
    },
    dependencies: dependencies(
      ['orchestration'],
      ['orchestration.scope', 'policy.permissions'],
      ['agent.spawn'],
      ['agent.as-tool', 'agent.handoff'],
    ),
    workspace: {
      required: false,
      access: 'inherited',
      containment: 'workspace-root',
      symlinkEscape: 'deny',
      resumePolicy: 'same-workspace',
    },
    security: {
      permissionPolicyRef: 'policy.permissions',
      sideEffects: 'approval-or-policy',
      network: 'policy-controlled',
      process: 'policy-controlled',
      childPolicy: 'inherit-stricter',
      secrets: 'runtime-service-only',
    },
    result: { artifacts: 'optional', citations: 'optional', artifactItemType: 'artifact_ref' },
    orchestration: {
      mode: 'supervisor',
      refs: ['ChildRunner', 'agentAsTool', 'createHandoff'],
      deterministic: false,
      reducerRequired: false,
      childFailurePolicy: 'fail-fast',
      childBudget: {
        maxChildRuns: 8,
        maxDepth: 3,
        maxTotalTokens: 1_000_000,
        maxCostUsd: 100,
      },
      durable: false,
    },
  },
  background: {
    id: 'background-agent',
    name: 'Background Agent',
    description: 'A durable child profile whose progress is recoverable through a checkpoint-backed manager.',
    instructions: [
      'Perform the assigned durable unit of work within the persisted scope.',
      'Do not assume an in-memory caller remains alive; make side effects idempotent or require reconciliation.',
    ].join(' '),
    limits: {
      maxTurns: 32,
      runDeadlineMs: 3_600_000,
      modelCallTimeoutMs: 180_000,
      toolTimeoutMs: 300_000,
      hookTimeoutMs: 30_000,
      maxParallelTools: 4,
      maxSubagentDepth: 2,
      maxSubagentFanout: 4,
      streamBufferSize: 256,
      maxInputTokens: 512_000,
      maxOutputTokens: 32_768,
      maxTotalTokens: 1_000_000,
      maxCostUsd: 100,
    },
    dependencies: dependencies(
      ['checkpoints', 'background'],
      ['orchestration.scope', 'background.checkpoint'],
      [],
      ['background.query', 'background.cancel'],
    ),
    workspace: {
      required: false,
      access: 'inherited',
      containment: 'workspace-root',
      symlinkEscape: 'deny',
      resumePolicy: 'same-workspace',
    },
    security: {
      permissionPolicyRef: 'policy.permissions',
      sideEffects: 'approval-or-policy',
      network: 'policy-controlled',
      process: 'policy-controlled',
      childPolicy: 'inherit-stricter',
      secrets: 'runtime-service-only',
    },
    result: { artifacts: 'optional', citations: 'optional', artifactItemType: 'artifact_ref' },
    orchestration: {
      mode: 'background',
      refs: ['BackgroundChildManager', 'DurableChildStore'],
      deterministic: false,
      reducerRequired: false,
      childFailurePolicy: 'fail-fast',
      childBudget: {
        maxChildRuns: 4,
        maxDepth: 2,
        maxTotalTokens: 1_000_000,
        maxCostUsd: 100,
      },
      durable: true,
      checkpointServiceId: 'checkpoints',
    },
  },
});

/** Build an immutable AgentSpec plus the runtime composition it requires. */
export function buildProfile<TContext = unknown, TOutput = string>(
  kind: AgentProfileKind,
  options: BuildProfileOptions<TContext, TOutput> = {},
): BuiltAgentProfile<TContext, TOutput> {
  assertProfileKind(kind);
  const definition = PROFILE_DEFINITIONS[kind];
  const id = options.id ?? definition.id;
  const name = options.name ?? definition.name;
  if (!id.trim()) throw new TypeError('Profile agent id must not be empty.');
  if (!name.trim()) throw new TypeError('Profile agent name must not be empty.');

  const limits = resolveLimits(definition.limits, options.limits);
  const optIns = Object.freeze({
    memory: options.optIns?.memory === true,
    skills: options.optIns?.skills === true,
    compaction: options.optIns?.compaction === true,
  });
  const dependenciesValue = resolveDependencies(definition.dependencies, optIns, options);
  const orchestration = resolveOrchestration(definition.orchestration, limits);
  const config: AgentProfileConfig = deepFreeze({
    schemaVersion: 1,
    kind,
    limits,
    optIns,
    dependencies: dependenciesValue,
    workspace: clonePlain(definition.workspace),
    security: clonePlain(definition.security),
    result: clonePlain(definition.result),
    orchestration,
  });

  const metadata: JsonObject = {
    ...(options.metadata ? cloneJsonValue(options.metadata) : {}),
    actoviqProfile: profileMetadata(config),
  };
  const spec: AgentSpec<TContext, TOutput> = {
    id,
    name,
    description: options.description ?? definition.description,
    instructions: options.instructions ?? definition.instructions,
    model: cloneModelRef(options.model),
    tools: optionalArray(dependenciesValue.requiredTools),
    handoffs: cloneHandoffs(options.handoffs),
    output: cloneOutputSchema(options.output),
    inputGuardrails: cloneInputGuardrails(options.inputGuardrails),
    outputGuardrails: cloneOutputGuardrails(options.outputGuardrails),
    middleware: optionalArray(dependenciesValue.requiredMiddleware) as readonly MiddlewareRef<TContext>[] | undefined,
    limits,
    metadata,
  };
  const built: BuiltAgentProfile<TContext, TOutput> = {
    kind,
    spec: deepFreeze(spec),
    config,
  };
  return deepFreeze(built);
}

/** Return a stable, immutable view suitable for diagnostics and composition checks. */
export function inspectProfile<TContext, TOutput>(
  profile: BuiltAgentProfile<TContext, TOutput>,
): AgentProfileInspection<TContext, TOutput> {
  if (!profile || !AGENT_PROFILE_KINDS.includes(profile.kind)) {
    throw new TypeError('inspectProfile requires a built agent profile.');
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: profile.kind,
    spec: profile.spec,
    config: profile.config,
  });
}

export class ProfileRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileRuntimeConfigurationError';
  }
}

/** Validate composition without resolving lazy services or performing I/O. */
export function assertProfileRuntime<TContext, TOutput>(
  profile: BuiltAgentProfile<TContext, TOutput>,
  runtime: Pick<AgentRuntime, 'services' | 'middlewareRegistry' | 'tools'>,
  options: Pick<RunOptions<TContext>, 'workspaceId'> = {},
): void {
  const missingServices = profile.config.dependencies.requiredServices
    .filter(id => !runtime.services.has(id));
  const missingMiddleware = profile.config.dependencies.requiredMiddleware
    .map(refId)
    .filter(id => !runtime.middlewareRegistry.has(id));
  const missingTools = profile.config.dependencies.requiredTools
    .map(refId)
    .filter(id => !runtime.tools.has(id));
  const failures: string[] = [];
  if (missingServices.length > 0) failures.push(`services: ${missingServices.join(', ')}`);
  if (missingMiddleware.length > 0) failures.push(`middleware: ${missingMiddleware.join(', ')}`);
  if (missingTools.length > 0) failures.push(`tools: ${missingTools.join(', ')}`);
  if (profile.config.workspace.required && !options.workspaceId?.trim()) {
    failures.push('workspaceId');
  }
  if (failures.length > 0) {
    throw new ProfileRuntimeConfigurationError(
      `Profile "${profile.kind}" is missing runtime composition (${failures.join('; ')}).`,
    );
  }
}

/** Preferred execution helper: validates profile dependencies, then uses the same AgentRuntime. */
export function runProfile<TContext, TOutput>(
  runtime: AgentRuntime,
  profile: BuiltAgentProfile<TContext, TOutput>,
  input: AgentInput,
  options: RunOptions<TContext> = {},
) {
  assertProfileRuntime(profile, runtime, options);
  return runtime.run(profile.spec, input, options);
}

function dependencies(
  requiredServices: readonly RuntimeServiceId[],
  requiredMiddleware: readonly MiddlewareRef[],
  requiredTools: readonly ToolRef[],
  optionalTools: readonly ToolRef[] = [],
): ProfileDependencies {
  return {
    requiredServices,
    optionalServices: OPTIONAL_SERVICES,
    requiredMiddleware,
    optionalMiddleware: OPTIONAL_MIDDLEWARE,
    requiredTools,
    optionalTools,
  };
}

function noWorkspace(): ProfileWorkspaceExpectation {
  return {
    required: false,
    access: 'none',
    containment: 'not-applicable',
    symlinkEscape: 'not-applicable',
    resumePolicy: 'not-applicable',
  };
}

function noOrchestration(): ProfileOrchestrationExpectation {
  return {
    mode: 'none',
    refs: [],
    deterministic: false,
    reducerRequired: false,
    durable: false,
  };
}

function resolveDependencies<TContext, TOutput>(
  base: ProfileDependencies,
  optIns: Required<ProfileOptIns>,
  options: BuildProfileOptions<TContext, TOutput>,
): ProfileDependencies {
  const enabledFeatures = (Object.keys(optIns) as (keyof Required<ProfileOptIns>)[])
    .filter(feature => optIns[feature]);
  const requiredServices = uniqueStrings([
    ...base.requiredServices,
    ...enabledFeatures.map(feature => OPT_IN_SERVICE_REFS[feature]),
  ]);
  const requiredMiddleware = mergeRefs([
    ...base.requiredMiddleware,
    ...enabledFeatures.map(feature => OPT_IN_MIDDLEWARE_REFS[feature]),
  ], options.middleware ?? []);
  const requiredTools = mergeRefs(base.requiredTools, options.tools ?? []);
  return deepFreeze({
    requiredServices,
    optionalServices: base.optionalServices.filter(id => !requiredServices.includes(id)),
    requiredMiddleware,
    optionalMiddleware: filterRefs(base.optionalMiddleware, requiredMiddleware),
    requiredTools,
    optionalTools: filterRefs(base.optionalTools, requiredTools),
  });
}

function resolveOrchestration(
  value: ProfileOrchestrationExpectation,
  limits: RunLimits,
): ProfileOrchestrationExpectation {
  const childBudget = value.childBudget
    ? {
        maxChildRuns: Math.min(value.childBudget.maxChildRuns, limits.maxSubagentFanout),
        maxDepth: Math.min(value.childBudget.maxDepth, limits.maxSubagentDepth),
        maxTotalTokens: Math.min(value.childBudget.maxTotalTokens, limits.maxTotalTokens),
        maxCostUsd: Math.min(value.childBudget.maxCostUsd, limits.maxCostUsd),
      }
    : undefined;
  return deepFreeze({
    ...clonePlain(value),
    childBudget,
  });
}

function resolveLimits(base: RunLimits, patch: Partial<RunLimits> | undefined): RunLimits {
  const limits = { ...base, ...(patch ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Profile run limit ${name} must be a positive finite number.`);
    }
  }
  for (const name of [
    'maxTurns',
    'maxParallelTools',
    'maxSubagentDepth',
    'maxSubagentFanout',
    'streamBufferSize',
  ] as const) {
    if (!Number.isSafeInteger(limits[name])) {
      throw new RangeError(`Profile run limit ${name} must be a safe integer.`);
    }
  }
  if (limits.streamBufferSize < 2) {
    throw new RangeError('Profile streamBufferSize must be at least 2.');
  }
  return Object.freeze(limits);
}

function profileMetadata(config: AgentProfileConfig): JsonObject {
  const value: JsonObject = {
    schemaVersion: config.schemaVersion,
    kind: config.kind,
    optIns: {
      memory: config.optIns.memory,
      skills: config.optIns.skills,
      compaction: config.optIns.compaction,
    },
    requiredServices: config.dependencies.requiredServices,
    requiredMiddleware: config.dependencies.requiredMiddleware.map(refId),
    requiredTools: config.dependencies.requiredTools.map(refId),
    workspace: {
      required: config.workspace.required,
      access: config.workspace.access,
      containment: config.workspace.containment,
      symlinkEscape: config.workspace.symlinkEscape,
      resumePolicy: config.workspace.resumePolicy,
    },
    security: {
      permissionPolicyRef: config.security.permissionPolicyRef ?? null,
      sideEffects: config.security.sideEffects,
      network: config.security.network,
      process: config.security.process,
      childPolicy: config.security.childPolicy,
      secrets: config.security.secrets,
    },
    result: {
      artifacts: config.result.artifacts,
      citations: config.result.citations,
      citationsMetadataKey: config.result.citationsMetadataKey ?? null,
      artifactItemType: config.result.artifactItemType ?? null,
    },
    orchestration: {
      mode: config.orchestration.mode,
      refs: config.orchestration.refs,
      deterministic: config.orchestration.deterministic,
      reducerRequired: config.orchestration.reducerRequired,
      durable: config.orchestration.durable,
      checkpointServiceId: config.orchestration.checkpointServiceId ?? null,
      childFailurePolicy: config.orchestration.childFailurePolicy ?? null,
      childBudget: config.orchestration.childBudget
        ? {
            maxChildRuns: config.orchestration.childBudget.maxChildRuns,
            maxDepth: config.orchestration.childBudget.maxDepth,
            maxTotalTokens: config.orchestration.childBudget.maxTotalTokens,
            maxCostUsd: config.orchestration.childBudget.maxCostUsd,
          }
        : null,
    },
  };
  return cloneJsonValue(value);
}

function mergeRefs<T extends ToolRef | MiddlewareRef>(
  base: readonly T[],
  extra: readonly T[],
): readonly T[] {
  const merged = new Map<string, T>();
  for (const ref of [...base, ...extra]) merged.set(refId(ref), cloneRef(ref));
  return Object.freeze([...merged.values()]);
}

function filterRefs<T extends ToolRef | MiddlewareRef>(
  candidates: readonly T[],
  selected: readonly (ToolRef | MiddlewareRef)[],
): readonly T[] {
  const selectedIds = new Set(selected.map(refId));
  return Object.freeze(candidates
    .filter(ref => !selectedIds.has(refId(ref)))
    .map(cloneRef));
}

function cloneRef<T extends ToolRef | MiddlewareRef>(ref: T): T {
  if (typeof ref === 'string') return ref;
  return deepFreeze({
    id: ref.id,
    options: ref.options ? cloneJsonValue(ref.options) : undefined,
  }) as T;
}

function refId(ref: ToolRef | MiddlewareRef): string {
  return typeof ref === 'string' ? ref : ref.id;
}

function uniqueStrings<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)]);
}

function optionalArray<T>(values: readonly T[]): readonly T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function cloneModelRef(value: ModelRef | undefined): ModelRef | undefined {
  if (typeof value === 'string' || value === undefined) return value;
  return Object.freeze({ provider: value.provider, model: value.model });
}

function cloneHandoffs<TContext>(
  values: readonly HandoffRef<TContext>[] | undefined,
): readonly HandoffRef<TContext>[] | undefined {
  return values?.map(value => Object.freeze({
    id: value.id,
    targetAgentId: value.targetAgentId,
    description: value.description,
    filter: value.filter,
    metadata: value.metadata ? deepFreeze(cloneJsonValue(value.metadata)) : undefined,
  }));
}

function cloneOutputSchema<TOutput>(
  value: OutputSchema<TOutput> | undefined,
): OutputSchema<TOutput> | undefined {
  if (!value) return undefined;
  return Object.freeze({
    name: value.name,
    schema: deepFreeze(cloneJsonValue(value.schema)),
    description: value.description,
    strict: value.strict,
    parse: value.parse,
  });
}

function cloneInputGuardrails<TContext>(
  values: readonly InputGuardrail<TContext>[] | undefined,
): readonly InputGuardrail<TContext>[] | undefined {
  return values?.map(value => Object.freeze({
    id: value.id,
    evaluate: value.evaluate.bind(value),
  }));
}

function cloneOutputGuardrails<TContext, TOutput>(
  values: readonly OutputGuardrail<TContext, TOutput>[] | undefined,
): readonly OutputGuardrail<TContext, TOutput>[] | undefined {
  return values?.map(value => Object.freeze({
    id: value.id,
    evaluate: value.evaluate.bind(value),
  }));
}

function clonePlain<T>(value: T): T {
  return structuredClone(value);
}

function assertProfileKind(value: string): asserts value is AgentProfileKind {
  if (!AGENT_PROFILE_KINDS.includes(value as AgentProfileKind)) {
    throw new TypeError(`Unknown agent profile "${value}".`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
