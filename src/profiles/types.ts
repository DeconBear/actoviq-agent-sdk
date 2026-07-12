import type {
  AgentSpec,
  HandoffRef,
  InputGuardrail,
  JsonObject,
  MiddlewareRef,
  ModelRef,
  OutputGuardrail,
  OutputSchema,
  PromptSource,
  RunLimits,
  ToolRef,
} from '../core/index.js';
import type { RuntimeServiceId } from '../runtime-v2/services.js';

export const AGENT_PROFILE_KINDS = Object.freeze([
  'chat',
  'coding',
  'research',
  'workflow',
  'supervisor',
  'background',
] as const);

export type AgentProfileKind = (typeof AGENT_PROFILE_KINDS)[number];

export interface ProfileOptIns {
  /** Adds the memory service and memory middleware reference. */
  readonly memory?: boolean;
  /** Adds the skills service and skill-loading middleware reference. */
  readonly skills?: boolean;
  /** Adds the compaction service and compaction middleware reference. */
  readonly compaction?: boolean;
}

export interface ProfileDependencies {
  /** These references must be registered by the one owning AgentRuntime. */
  readonly requiredServices: readonly RuntimeServiceId[];
  /** Supported composition points that remain disabled until selected. */
  readonly optionalServices: readonly RuntimeServiceId[];
  readonly requiredMiddleware: readonly MiddlewareRef[];
  readonly optionalMiddleware: readonly MiddlewareRef[];
  readonly requiredTools: readonly ToolRef[];
  readonly optionalTools: readonly ToolRef[];
}

export interface ProfileWorkspaceExpectation {
  readonly required: boolean;
  readonly access: 'none' | 'read-only' | 'read-write' | 'inherited';
  readonly containment: 'not-applicable' | 'workspace-root';
  readonly symlinkEscape: 'not-applicable' | 'deny';
  readonly resumePolicy: 'not-applicable' | 'same-workspace';
}

export interface ProfileSecurityExpectation {
  /** A registry reference. The profile never implements or bypasses policy. */
  readonly permissionPolicyRef?: string;
  readonly sideEffects: 'none' | 'deny-by-default' | 'approval-or-policy';
  readonly network: 'disabled' | 'policy-controlled';
  readonly process: 'disabled' | 'policy-controlled';
  readonly childPolicy: 'none' | 'inherit-stricter';
  readonly secrets: 'runtime-service-only';
}

export interface ProfileResultExpectation {
  readonly artifacts: 'none' | 'optional' | 'required';
  readonly citations: 'none' | 'optional' | 'required';
  readonly citationsMetadataKey?: string;
  readonly artifactItemType?: 'artifact_ref';
}

export interface ProfileChildBudget {
  readonly maxChildRuns: number;
  readonly maxDepth: number;
  readonly maxTotalTokens: number;
  readonly maxCostUsd: number;
}

export interface ProfileOrchestrationExpectation {
  readonly mode: 'none' | 'workflow' | 'supervisor' | 'background';
  /** Registry/API references selected by this profile; no engine is embedded. */
  readonly refs: readonly string[];
  readonly deterministic: boolean;
  readonly reducerRequired: boolean;
  readonly childFailurePolicy?: 'fail-fast';
  readonly childBudget?: ProfileChildBudget;
  readonly durable: boolean;
  readonly checkpointServiceId?: RuntimeServiceId;
}

export interface AgentProfileConfig {
  readonly schemaVersion: 1;
  readonly kind: AgentProfileKind;
  readonly limits: Readonly<RunLimits>;
  readonly optIns: Readonly<Required<ProfileOptIns>>;
  readonly dependencies: ProfileDependencies;
  readonly workspace: ProfileWorkspaceExpectation;
  readonly security: ProfileSecurityExpectation;
  readonly result: ProfileResultExpectation;
  readonly orchestration: ProfileOrchestrationExpectation;
}

export interface BuildProfileOptions<TContext = unknown, TOutput = string> {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: PromptSource<TContext>;
  readonly model?: ModelRef;
  /** Extra tool references become required for this built profile. */
  readonly tools?: readonly ToolRef[];
  readonly handoffs?: readonly HandoffRef<TContext>[];
  readonly output?: OutputSchema<TOutput>;
  readonly inputGuardrails?: readonly InputGuardrail<TContext>[];
  readonly outputGuardrails?: readonly OutputGuardrail<TContext, TOutput>[];
  /** Extra middleware references become required for this built profile. */
  readonly middleware?: readonly MiddlewareRef<TContext>[];
  readonly limits?: Partial<RunLimits>;
  readonly metadata?: JsonObject;
  readonly optIns?: ProfileOptIns;
}

export interface BuiltAgentProfile<TContext = unknown, TOutput = string> {
  readonly kind: AgentProfileKind;
  readonly spec: Readonly<AgentSpec<TContext, TOutput>>;
  readonly config: AgentProfileConfig;
}

export interface AgentProfileInspection<TContext = unknown, TOutput = string> {
  readonly schemaVersion: 1;
  readonly kind: AgentProfileKind;
  readonly spec: Readonly<AgentSpec<TContext, TOutput>>;
  readonly config: AgentProfileConfig;
}
