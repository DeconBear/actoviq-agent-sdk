export class HadamardSdkError extends Error {
  readonly code: string;

  constructor(message: string, code = 'HADAMARD_SDK_ERROR', options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigurationError extends HadamardSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'CONFIGURATION_ERROR', options);
  }
}

export class SessionNotFoundError extends HadamardSdkError {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was not found.`, 'SESSION_NOT_FOUND');
  }
}

export class SessionConflictError extends HadamardSdkError {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(sessionId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Session "${sessionId}" changed since it was loaded (expected revision ${expectedRevision}, actual revision ${actualRevision}).`,
      'SESSION_CONFLICT',
    );
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class SessionDataError extends HadamardSdkError {
  readonly sessionId: string;

  constructor(sessionId: string, message: string, options?: { cause?: unknown }) {
    super(`Session "${sessionId}" is invalid: ${message}`, 'SESSION_DATA_INVALID', options);
    this.sessionId = sessionId;
  }
}

export class ToolExecutionError extends HadamardSdkError {
  readonly toolName: string;

  constructor(toolName: string, message: string, options?: { cause?: unknown }) {
    super(message, 'TOOL_EXECUTION_ERROR', options);
    this.toolName = toolName;
  }
}

export class RunAbortedError extends HadamardSdkError {
  constructor(message = 'The run was aborted.', options?: { cause?: unknown }) {
    super(message, 'RUN_ABORTED', options);
  }
}

export class DeadlineExceededError extends HadamardSdkError {
  readonly scope: string;
  readonly timeoutMs: number;

  constructor(scope: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${scope} exceeded its ${timeoutMs}ms deadline.`, 'DEADLINE_EXCEEDED', options);
    this.scope = scope;
    this.timeoutMs = timeoutMs;
  }
}

export class HadamardProviderApiError extends HadamardSdkError {
  readonly status: number;
  readonly errorType?: string;

  constructor(
    message: string,
    options: {
      status: number;
      errorType?: string;
      cause?: unknown;
    },
  ) {
    super(message, 'HADAMARD_PROVIDER_API_ERROR', options);
    this.status = options.status;
    this.errorType = options.errorType;
  }
}

export class HadamardBridgeProcessError extends HadamardSdkError {
  readonly stderr?: string;
  readonly exitCode?: number | null;

  constructor(
    message: string,
    options?: { cause?: unknown; stderr?: string; exitCode?: number | null },
  ) {
    super(message, 'HADAMARD_BRIDGE_PROCESS_ERROR', options);
    this.stderr = options?.stderr;
    this.exitCode = options?.exitCode;
  }
}

