export type WorkflowTrustTier = 'trusted' | 'untrusted';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowExecutionRequestBase {
  /** Source must evaluate to `(context) => JsonValue | Promise<JsonValue>`. */
  readonly source: string;
  readonly input?: JsonValue;
  /** Finite wall-clock deadline for this execution. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Per-run subset of executor capabilities exposed to the script. Default: none. */
  readonly capabilities?: readonly string[];
}

export interface TrustedWorkflowExecutionRequest extends WorkflowExecutionRequestBase {
  readonly trust: 'trusted';
}

export interface UntrustedWorkflowExecutionRequest extends WorkflowExecutionRequestBase {
  readonly trust: 'untrusted';
  /** Explicit cwd for the isolated child. It must already exist and be a directory. */
  readonly workspaceDir: string;
}

export type WorkflowExecutionRequest =
  | TrustedWorkflowExecutionRequest
  | UntrustedWorkflowExecutionRequest;

export interface WorkflowExecutionResult {
  readonly value: JsonValue;
  readonly trust: WorkflowTrustTier;
  readonly executor: string;
  readonly durationMs: number;
  readonly capabilityCalls: number;
}

export interface WorkflowCapabilityContext {
  readonly name: string;
  readonly trust: WorkflowTrustTier;
  readonly signal: AbortSignal;
  readonly workspaceDir?: string;
}

export type WorkflowCapabilityHandler = (
  input: JsonValue,
  context: WorkflowCapabilityContext,
) => JsonValue | PromiseLike<JsonValue>;

export type WorkflowCapabilityMap = Readonly<Record<string, WorkflowCapabilityHandler>>;

export interface TrustedWorkflowExecutor {
  readonly kind: string;
  execute(request: TrustedWorkflowExecutionRequest): Promise<WorkflowExecutionResult>;
}

/**
 * Pluggable boundary for local-process, container, or remote isolation.
 * Container and remote implementations can enforce stronger CPU, memory,
 * filesystem, and network policy without changing the runtime contract.
 */
export interface SandboxWorkflowExecutor {
  readonly kind: string;
  readonly isolation: 'local-process' | 'container' | 'remote';
  execute(request: UntrustedWorkflowExecutionRequest): Promise<WorkflowExecutionResult>;
}

export interface ExternalSandboxWorkflowExecutor extends SandboxWorkflowExecutor {
  readonly isolation: 'container' | 'remote';
}

export interface WorkflowExecutorRouterOptions {
  readonly trustedExecutor?: TrustedWorkflowExecutor;
  readonly sandboxExecutor?: SandboxWorkflowExecutor;
}

export interface WorkflowExecutorLimits {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxProtocolMessages?: number;
}
