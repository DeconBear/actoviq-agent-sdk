import type { WorkflowTrustTier } from './types.js';

export class WorkflowExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowExecutorError';
    this.code = code;
  }
}

export class UntrustedWorkflowRejectedError extends WorkflowExecutorError {
  constructor() {
    super(
      'UNTRUSTED_WORKFLOW_REJECTED',
      'Untrusted workflow execution is disabled until a SandboxWorkflowExecutor is supplied.',
    );
    this.name = 'UntrustedWorkflowRejectedError';
  }
}

export class WorkflowTrustTierError extends WorkflowExecutorError {
  constructor(expected: WorkflowTrustTier, actual: unknown) {
    super(
      'WORKFLOW_TRUST_TIER_MISMATCH',
      `This executor requires trust=${expected}; received ${String(actual)}.`,
    );
    this.name = 'WorkflowTrustTierError';
  }
}

export class WorkflowTimeoutError extends WorkflowExecutorError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(
      'WORKFLOW_TIMEOUT',
      `Workflow exceeded its wall-clock deadline of ${timeoutMs}ms.`,
      options,
    );
    this.name = 'WorkflowTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class WorkflowAbortedError extends WorkflowExecutorError {
  constructor(reason?: unknown) {
    const detail = reason instanceof Error
      ? reason.message
      : typeof reason === 'string' && reason.length > 0
        ? reason
        : 'Workflow execution was aborted.';
    super(
      'WORKFLOW_ABORTED',
      detail,
      reason instanceof Error ? { cause: reason } : undefined,
    );
    this.name = 'WorkflowAbortedError';
  }
}

export class WorkflowOutputLimitError extends WorkflowExecutorError {
  readonly maxOutputBytes: number;

  constructor(maxOutputBytes: number, options?: ErrorOptions) {
    super(
      'WORKFLOW_OUTPUT_LIMIT_EXCEEDED',
      `Workflow output exceeded the ${maxOutputBytes}-byte limit.`,
      options,
    );
    this.name = 'WorkflowOutputLimitError';
    this.maxOutputBytes = maxOutputBytes;
  }
}

export class WorkflowMessageLimitError extends WorkflowExecutorError {
  readonly maxMessageBytes: number;

  constructor(maxMessageBytes: number, detail = 'Workflow protocol message', options?: ErrorOptions) {
    super(
      'WORKFLOW_MESSAGE_LIMIT_EXCEEDED',
      `${detail} exceeded the ${maxMessageBytes}-byte limit.`,
      options,
    );
    this.name = 'WorkflowMessageLimitError';
    this.maxMessageBytes = maxMessageBytes;
  }
}

export class WorkflowProtocolError extends WorkflowExecutorError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKFLOW_PROTOCOL_ERROR', message, options);
    this.name = 'WorkflowProtocolError';
  }
}

export class WorkflowCapabilityNotAllowedError extends WorkflowExecutorError {
  readonly capability: string;

  constructor(capability: string) {
    super(
      'WORKFLOW_CAPABILITY_NOT_ALLOWED',
      `Workflow capability "${capability}" is not configured for this executor.`,
    );
    this.name = 'WorkflowCapabilityNotAllowedError';
    this.capability = capability;
  }
}

export class WorkflowExecutionError extends WorkflowExecutorError {
  readonly remoteCode?: string;

  constructor(message: string, options?: ErrorOptions & { remoteCode?: string }) {
    super('WORKFLOW_EXECUTION_FAILED', message, options);
    this.name = 'WorkflowExecutionError';
    this.remoteCode = options?.remoteCode;
  }
}

export class WorkflowConfigurationError extends WorkflowExecutorError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKFLOW_CONFIGURATION_ERROR', message, options);
    this.name = 'WorkflowConfigurationError';
  }
}
