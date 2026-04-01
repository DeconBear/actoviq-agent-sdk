export class ActoviqSdkError extends Error {
  readonly code: string;

  constructor(message: string, code = 'ACTOVIQ_SDK_ERROR', options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigurationError extends ActoviqSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'CONFIGURATION_ERROR', options);
  }
}

export class SessionNotFoundError extends ActoviqSdkError {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was not found.`, 'SESSION_NOT_FOUND');
  }
}

export class ToolExecutionError extends ActoviqSdkError {
  readonly toolName: string;

  constructor(toolName: string, message: string, options?: { cause?: unknown }) {
    super(message, 'TOOL_EXECUTION_ERROR', options);
    this.toolName = toolName;
  }
}

export class RunAbortedError extends ActoviqSdkError {
  constructor(message = 'The run was aborted.', options?: { cause?: unknown }) {
    super(message, 'RUN_ABORTED', options);
  }
}

export class ActoviqBridgeProcessError extends ActoviqSdkError {
  readonly stderr?: string;
  readonly exitCode?: number | null;

  constructor(
    message: string,
    options?: { cause?: unknown; stderr?: string; exitCode?: number | null },
  ) {
    super(message, 'ACTOVIQ_BRIDGE_PROCESS_ERROR', options);
    this.stderr = options?.stderr;
    this.exitCode = options?.exitCode;
  }
}
