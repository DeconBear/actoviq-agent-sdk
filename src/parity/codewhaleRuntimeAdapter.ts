import { HadamardBridgeProcessError } from '../errors.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeToolsOption,
} from '../types.js';

/** Read-only CodeWhale tools that are safe to expose without headless approval. */
export const CODEWHALE_READ_ONLY_TOOLS = [
  'file_search',
  'git_diff',
  'git_status',
  'grep_files',
  'list_dir',
  'read_file',
] as const;

const CODEWHALE_READ_ONLY_TOOL_SET = new Set<string>(CODEWHALE_READ_ONLY_TOOLS);
const CODEWHALE_CORRELATION_HINT = /^<redacted:[0-9a-f]{16}>$/u;
const CODEWHALE_FAILED_STATUSES = new Set([
  'canceled',
  'cancelled',
  'error',
  'failed',
  'interrupted',
]);

export interface CodewhaleRuntimeNormalizer {
  /** Stable redacted label used only to correlate the persisted native session. */
  readonly correlationHint: string | undefined;
  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[];
}

/**
 * Build argv for CodeWhale's non-interactive exec protocol.
 *
 * CodeWhale 0.8.65 cannot express Hadamard's `acceptEdits` boundary: `--auto`
 * can elevate a sandbox denial to danger-full-access. That mode therefore
 * fails closed instead of silently widening permissions.
 */
export function buildCodewhaleArgs(
  prompt: string,
  options: HadamardBridgeRunOptions,
): string[] {
  const permissionMode = options.permissionMode ?? 'default';
  if (permissionMode === 'acceptEdits') {
    throw new HadamardBridgeProcessError(
      'acceptEdits is not supported safely by CodeWhale headless exec; use default/plan for read-only access or explicitly select bypassPermissions.',
    );
  }

  const bypassPermissions = permissionMode === 'bypassPermissions'
    || options.dangerouslySkipPermissions === true;
  if (
    permissionMode !== 'default'
    && permissionMode !== 'plan'
    && permissionMode !== 'dontAsk'
    && permissionMode !== 'bypassPermissions'
  ) {
    throw new HadamardBridgeProcessError(
      `Unsupported CodeWhale permission mode: ${String(permissionMode)}`,
    );
  }

  const modelSelection = codewhaleModelSelection(options);
  const args = modelSelection.provider
    ? ['--provider', modelSelection.provider, 'exec', '--output-format', 'stream-json']
    : ['exec', '--output-format', 'stream-json'];
  const requestedTools = requestedAllowedTools(options.tools, options.allowedTools);

  if (bypassPermissions) {
    args.push('--auto');
    if (requestedTools !== undefined) {
      args.push('--allowed-tools', requestedTools.join(','));
    }
  } else {
    const readOnlyTools = (requestedTools ?? [...CODEWHALE_READ_ONLY_TOOLS])
      .filter(tool => CODEWHALE_READ_ONLY_TOOL_SET.has(tool));
    args.push('--allowed-tools', readOnlyTools.join(','));
  }

  const disallowedTools = normalizeToolNames(options.disallowedTools ?? []);
  if (disallowedTools.length > 0) {
    args.push('--disallowed-tools', disallowedTools.join(','));
  }

  if (modelSelection.model != null) {
    args.push('--model', validateModel(modelSelection.model));
  }
  if (options.maxTurns != null) {
    if (
      !Number.isSafeInteger(options.maxTurns)
      || options.maxTurns < 1
      || options.maxTurns > 0xffff_ffff
    ) {
      throw new HadamardBridgeProcessError(
        'CodeWhale maxTurns must be a positive safe integer.',
      );
    }
    args.push('--max-turns', String(options.maxTurns));
  }

  const systemPrompt = combineSystemPrompts(options.systemPrompt, options.appendSystemPrompt);
  if (systemPrompt) {
    // CodeWhale exposes one additive system-prompt flag. Combining both inputs
    // preserves their order without pretending the native constitution is replaced.
    args.push('--append-system-prompt', systemPrompt);
  }

  const explicitResumeId = typeof options.resume === 'string'
    ? validateCodewhaleSessionId(options.resume)
    : options.resume === true && options.sessionId
      ? validateCodewhaleSessionId(options.sessionId)
      : undefined;
  if (explicitResumeId) {
    args.push(`--resume=${explicitResumeId}`);
  } else if (options.resume === true || options.continueMostRecent === true) {
    args.push('--continue');
  }

  // CodeWhale's prompt is a trailing positional argument. Keep it behind the
  // option boundary so prompt text can never enable --auto or another flag.
  args.push('--', prompt);
  return args;
}

function codewhaleModelSelection(
  options: HadamardBridgeRunOptions,
): { provider?: string; model?: string } {
  const model = options.model?.trim();
  const separator = model?.indexOf('/') ?? -1;
  if (model && separator > 0 && separator < model.length - 1) {
    return {
      provider: validateProvider(model.slice(0, separator)),
      model: model.slice(separator + 1),
    };
  }
  return {
    provider: options.credentialProvider
      ? validateProvider(options.credentialProvider)
      : undefined,
    model,
  };
}

function validateProvider(value: string): string {
  const provider = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider)) {
    throw new HadamardBridgeProcessError(
      'CodeWhale provider must contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return provider;
}

export function createCodewhaleNormalizer(): CodewhaleRuntimeNormalizer {
  return new CodewhaleNormalizer();
}

function requestedAllowedTools(
  tools: HadamardBridgeToolsOption | undefined,
  allowedTools: string[] | undefined,
): string[] | undefined {
  if (tools === 'none') {
    return [];
  }
  const hasExplicitSelection = Array.isArray(tools) || allowedTools !== undefined;
  if (!hasExplicitSelection) {
    return undefined;
  }
  return normalizeToolNames([
    ...(Array.isArray(tools) ? tools : []),
    ...(allowedTools ?? []),
  ]);
}

function normalizeToolNames(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const tool = value.trim();
    if (!tool || tool.includes(',') || /[\u0000-\u001f\u007f]/u.test(tool)) {
      throw new HadamardBridgeProcessError(
        'CodeWhale tool names must be non-empty values without commas or control characters.',
      );
    }
    normalized.add(tool);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function validateModel(value: string): string {
  const model = value.trim();
  if (
    !model
    || model.length > 512
    || model.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(model)
  ) {
    throw new HadamardBridgeProcessError(
      'CodeWhale model must be a non-option value without control characters.',
    );
  }
  return model;
}

function validateCodewhaleSessionId(value: string): string {
  const sessionId = value.trim();
  if (
    !sessionId
    || sessionId.length > 256
    || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(sessionId)
  ) {
    throw new HadamardBridgeProcessError(
      'CodeWhale session id must be a non-option identifier containing only letters, numbers, underscores, and hyphens.',
    );
  }
  return sessionId;
}

function combineSystemPrompts(
  systemPrompt: string | undefined,
  appendSystemPrompt: string | undefined,
): string | undefined {
  const parts = [systemPrompt, appendSystemPrompt]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

class CodewhaleNormalizer implements CodewhaleRuntimeNormalizer {
  private assistantText = '';
  private initEmitted = false;
  private terminal = false;
  private model: string | undefined;
  private cwd: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private messageCount: number | undefined;
  private status: string | undefined;
  private sessionCorrelationHint: string | undefined;

  get correlationHint(): string | undefined {
    return this.sessionCorrelationHint;
  }

  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (this.terminal) {
      return [];
    }

    switch (raw.type) {
      case 'content':
        return this.translateContent(raw);
      case 'tool_use':
        return this.translateToolUse(raw);
      case 'tool_result':
        return this.translateToolResult(raw);
      case 'metadata':
        return this.translateMetadata(raw);
      case 'done':
        return this.translateDone();
      case 'error':
        return this.translateError(raw);
      default:
        return [];
    }
  }

  private translateContent(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.content !== 'string' || raw.content.length === 0) {
      return [];
    }
    this.assistantText += raw.content;
    return [bridgeEvent('stream_event', {
      session_id: '',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: raw.content },
      },
    })];
  }

  private translateToolUse(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') {
      return [];
    }
    return [bridgeEvent('assistant', {
      session_id: '',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: raw.id,
          name: raw.name,
          input: raw.input ?? {},
        }],
      },
    })];
  }

  private translateToolResult(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.id !== 'string' || typeof raw.output !== 'string') {
      return [];
    }
    return [bridgeEvent('user', {
      session_id: '',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: raw.id,
          content: raw.output,
          is_error: raw.status !== 'success',
        }],
      },
    })];
  }

  private translateMetadata(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (!isRecord(raw.meta)) {
      return [];
    }
    this.model = stringValue(raw.meta.model) ?? this.model;
    this.cwd = stringValue(raw.meta.workspace) ?? this.cwd;
    this.inputTokens = numberValue(raw.meta.input_tokens) ?? this.inputTokens;
    this.outputTokens = numberValue(raw.meta.output_tokens) ?? this.outputTokens;
    this.messageCount = numberValue(raw.meta.message_count) ?? this.messageCount;
    this.status = stringValue(raw.meta.status) ?? this.status;
    const candidate = stringValue(raw.meta.session_id);
    if (candidate && CODEWHALE_CORRELATION_HINT.test(candidate)) {
      this.sessionCorrelationHint = candidate;
    }
    return this.emitInit();
  }

  private translateDone(): HadamardBridgeJsonEvent[] {
    this.terminal = true;
    const failed = this.status != null
      && CODEWHALE_FAILED_STATUSES.has(this.status.toLowerCase());
    const events = this.emitInit();
    if (this.assistantText) {
      events.push(bridgeEvent('assistant', {
        session_id: '',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: this.assistantText }],
        },
      }));
    }
    events.push(this.buildResult(
      failed,
      this.assistantText,
      failed ? this.status ?? 'error' : 'end_turn',
    ));
    return events;
  }

  private translateError(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.error !== 'string') {
      return [];
    }
    this.terminal = true;
    return [
      ...this.emitInit(),
      this.buildResult(true, raw.error, 'error'),
    ];
  }

  private emitInit(): HadamardBridgeJsonEvent[] {
    if (this.initEmitted) {
      return [];
    }
    this.initEmitted = true;
    const init = bridgeEvent('system', {
      subtype: 'init',
      session_id: '',
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      agents: [],
      skills: [],
      plugins: [],
    });
    if (this.cwd) init.cwd = this.cwd;
    if (this.model) init.model = this.model;
    if (this.sessionCorrelationHint) init.correlationHint = this.sessionCorrelationHint;
    return [init];
  }

  private buildResult(
    isError: boolean,
    result: string,
    stopReason: string,
  ): HadamardBridgeJsonEvent {
    const event = bridgeEvent('result', {
      subtype: isError ? 'error' : 'success',
      session_id: '',
      is_error: isError,
      result,
      stop_reason: stopReason,
      num_turns: 1,
    });
    if (this.model) event.model = this.model;
    if (this.inputTokens != null) event.input_tokens = this.inputTokens;
    if (this.outputTokens != null) event.output_tokens = this.outputTokens;
    if (this.messageCount != null) event.message_count = this.messageCount;
    if (this.sessionCorrelationHint) event.correlationHint = this.sessionCorrelationHint;
    return event;
  }
}

function bridgeEvent(
  type: string,
  fields: Record<string, unknown>,
): HadamardBridgeJsonEvent {
  return { type, ...fields };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
