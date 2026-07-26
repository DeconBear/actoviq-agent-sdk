import type {
  ActoviqBridgeJsonEvent,
  ActoviqBridgePermissionMode,
} from '../types.js';

export type ReasonixAcpJsonRpcId = string | number;

export interface ReasonixAcpJsonRpcRecord extends Record<string, unknown> {
  jsonrpc: '2.0';
  id?: ReasonixAcpJsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface CreateReasonixAcpSessionOptions {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  permissionMode: ActoviqBridgePermissionMode;
  nativeSessionId?: string;
}

export type ReasonixAcpTurnOptions = Pick<
  CreateReasonixAcpSessionOptions,
  'prompt' | 'model' | 'effort' | 'maxBudgetUsd' | 'permissionMode'
>;

export interface ReasonixAcpHandleResult {
  outbound: ReasonixAcpJsonRpcRecord[];
  events: ActoviqBridgeJsonEvent[];
  done: boolean;
  nativeSessionId?: string;
}

export interface ReasonixAcpSession {
  start(): ReasonixAcpJsonRpcRecord[];
  nextTurn(options: ReasonixAcpTurnOptions): ReasonixAcpHandleResult;
  handle(record: Record<string, unknown>): ReasonixAcpHandleResult;
  cancel(): ReasonixAcpJsonRpcRecord[];
  canContinue(): boolean;
}

type PendingRequestKind = 'initialize' | 'session' | 'config' | 'prompt';

interface PendingRequest {
  id: number;
  kind: PendingRequestKind;
}

interface ConfigChange {
  id: string;
  value: string;
}

interface PermissionOption {
  optionId: string;
  kind: string;
}

const JSON_RPC_VERSION = '2.0' as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonRpcId(value: unknown): ReasonixAcpJsonRpcId | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function bridgeEvent(
  type: string,
  fields: Record<string, unknown> = {},
): ActoviqBridgeJsonEvent {
  return { type, ...fields } as ActoviqBridgeJsonEvent;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (isRecord(value.content)) return textFromContent(value.content);
  return '';
}

function toolResultText(value: unknown): string {
  if (!Array.isArray(value)) return textFromContent(value);
  return value
    .map(item => {
      const text = textFromContent(item);
      if (text) return text;
      if (!isRecord(item)) return typeof item === 'string' ? item : '';
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter(Boolean)
    .join('\n');
}

function toolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      return { value };
    }
  }
  return value === undefined ? {} : { value };
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value;
  if (isRecord(value)) {
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.error === 'string' && value.error) return value.error;
  }
  return fallback;
}

function isEditPermission(toolCall: Record<string, unknown>): boolean {
  const kind = String(toolCall.kind ?? '').trim().toLowerCase();
  if (kind === 'edit' || kind === 'write') return true;
  if (kind && kind !== 'other') return false;
  const title = String(toolCall.title ?? '').trim().toLowerCase();
  return /(?:^|[_\s-])(edit|write|patch|replace)(?:$|[_\s-])/u.test(title);
}

function parsePermissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const optionId = stringValue(item.optionId);
    const kind = stringValue(item.kind);
    return optionId && kind ? [{ optionId, kind }] : [];
  });
}

class ReasonixAcpSessionState implements ReasonixAcpSession {
  private nextId = 1;
  private started = false;
  private completed = false;
  private cancelSent = false;
  private promptStarted = false;
  private pending: PendingRequest | undefined;
  private nativeSessionId: string | undefined;
  private sessionOpened = false;
  private advertisedConfigOptions: unknown;
  private configChanges: ConfigChange[] = [];
  private assistantText = '';
  private lastError: string | undefined;
  private readonly emittedToolCalls = new Set<string>();
  private readonly emittedToolResults = new Set<string>();

  constructor(private options: CreateReasonixAcpSessionOptions) {
    this.nativeSessionId = stringValue(options.nativeSessionId);
    this.validateBudget(options.maxBudgetUsd);
  }

  start(): ReasonixAcpJsonRpcRecord[] {
    if (this.started || this.completed) return [];
    this.started = true;
    return [this.request('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'actoviq-agent-sdk',
        title: 'Actoviq',
      },
      clientCapabilities: {},
    }, 'initialize')];
  }

  nextTurn(options: ReasonixAcpTurnOptions): ReasonixAcpHandleResult {
    if (!this.started || !this.completed || !this.sessionOpened || !this.nativeSessionId) {
      throw new Error('Reasonix ACP session is not ready for another turn.');
    }
    this.validateBudget(options.maxBudgetUsd);
    this.options = {
      ...this.options,
      ...options,
      nativeSessionId: this.nativeSessionId,
    };
    this.resetTurn();
    this.configChanges = this.requestedConfigChanges(this.advertisedConfigOptions);
    const next = this.advanceConfiguration();
    return this.result(next.outbound, [this.initEvent(), ...next.events]);
  }

  canContinue(): boolean {
    return this.sessionOpened && Boolean(this.nativeSessionId);
  }

  handle(record: Record<string, unknown>): ReasonixAcpHandleResult {
    if (this.completed) return this.result([], []);
    if (record.jsonrpc !== undefined && record.jsonrpc !== JSON_RPC_VERSION) {
      return this.fail('Reasonix ACP sent an unsupported JSON-RPC version.');
    }

    const method = stringValue(record.method);
    if (method) return this.handleInboundMethod(method, record);

    const id = jsonRpcId(record.id);
    if (id === undefined || id !== this.pending?.id) return this.result([], []);

    const pending = this.pending;
    this.pending = undefined;
    if (record.error !== undefined) {
      return this.fail(errorMessage(record.error, `${pending.kind} failed`));
    }

    switch (pending.kind) {
      case 'initialize':
        return this.handleInitializeResult(record.result);
      case 'session':
        return this.handleSessionResult(record.result);
      case 'config':
        return this.advanceConfiguration();
      case 'prompt':
        return this.handlePromptResult(record.result);
    }
  }

  cancel(): ReasonixAcpJsonRpcRecord[] {
    if (this.completed || this.cancelSent || !this.nativeSessionId) return [];
    this.cancelSent = true;
    return [{
      jsonrpc: JSON_RPC_VERSION,
      method: 'session/cancel',
      params: { sessionId: this.nativeSessionId },
    }];
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    kind: PendingRequestKind,
  ): ReasonixAcpJsonRpcRecord {
    const id = this.nextId++;
    this.pending = { id, kind };
    return { jsonrpc: JSON_RPC_VERSION, id, method, params };
  }

  private handleInboundMethod(
    method: string,
    record: Record<string, unknown>,
  ): ReasonixAcpHandleResult {
    if (method === 'session/update') {
      return this.result([], this.translateUpdate(record.params));
    }

    const id = jsonRpcId(record.id);
    if (method === 'session/request_permission' && id !== undefined) {
      const response = this.permissionResponse(id, record.params);
      const params = isRecord(record.params) ? record.params : {};
      const outcome = isRecord(response.result) && isRecord(response.result.outcome)
        ? response.result.outcome
        : {};
      return this.result([response], [bridgeEvent('system', {
        subtype: 'permission_request',
        session_id: this.nativeSessionId ?? '',
        tool_call: isRecord(params.toolCall) ? params.toolCall : {},
        decision: outcome.outcome,
        option_id: outcome.optionId,
      })]);
    }

    // Unknown notifications are intentionally ignored. Unknown requests get a
    // protocol-level response so the Reasonix process cannot wait forever.
    if (id === undefined) return this.result([], []);
    return this.result([{
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }], []);
  }

  private handleInitializeResult(value: unknown): ReasonixAcpHandleResult {
    const result = isRecord(value) ? value : {};
    if (typeof result.protocolVersion === 'number' && result.protocolVersion !== 1) {
      return this.fail(`Unsupported Reasonix ACP protocol version ${result.protocolVersion}.`);
    }

    if (this.nativeSessionId) {
      const capabilities = isRecord(result.agentCapabilities)
        ? result.agentCapabilities
        : undefined;
      if (capabilities?.loadSession === false) {
        return this.fail('This Reasonix ACP version cannot load persisted sessions.');
      }
      return this.result([
        this.request('session/load', {
          sessionId: this.nativeSessionId,
          cwd: this.options.cwd,
        }, 'session'),
      ], []);
    }

    return this.result([
      this.request('session/new', { cwd: this.options.cwd }, 'session'),
    ], []);
  }

  private handleSessionResult(value: unknown): ReasonixAcpHandleResult {
    const sessionResult = isRecord(value) ? value : {};
    if (!this.nativeSessionId) {
      this.nativeSessionId = stringValue(sessionResult.sessionId);
      if (!this.nativeSessionId) {
        return this.fail('Reasonix ACP did not return a session id.');
      }
    }

    this.sessionOpened = true;
    this.advertisedConfigOptions = sessionResult.configOptions;
    this.configChanges = this.requestedConfigChanges(this.advertisedConfigOptions);
    const initEvent = this.initEvent();
    const next = this.advanceConfiguration();
    return this.result(next.outbound, [initEvent, ...next.events]);
  }

  private initEvent(): ActoviqBridgeJsonEvent {
    return bridgeEvent('system', {
      subtype: 'init',
      session_id: this.nativeSessionId,
      cwd: this.options.cwd,
      model: this.options.model,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      agents: [],
      skills: [],
      plugins: [],
    });
  }

  private requestedConfigChanges(value: unknown): ConfigChange[] {
    if (!Array.isArray(value)) return [];
    const advertised = value.filter(isRecord);
    const changes: ConfigChange[] = [];

    const add = (ids: string[], desired: string | undefined): void => {
      if (desired === undefined || desired === '') return;
      const option = advertised.find(item => ids.includes(String(item.id ?? '')));
      if (!option || option.currentValue === desired) return;
      changes.push({ id: String(option.id), value: desired });
    };

    add(['model'], this.options.model);
    add(['effort'], this.options.effort);
    add(
      ['budget', 'budgetUsd', 'budget_usd', 'maxBudgetUsd', 'max_budget_usd'],
      this.options.maxBudgetUsd === undefined ? undefined : String(this.options.maxBudgetUsd),
    );
    return changes;
  }

  private advanceConfiguration(): ReasonixAcpHandleResult {
    const change = this.configChanges.shift();
    if (change) {
      return this.result([
        this.request('session/set_config_option', {
          sessionId: this.nativeSessionId,
          configId: change.id,
          value: change.value,
        }, 'config'),
      ], []);
    }
    this.promptStarted = true;
    return this.result([
      this.request('session/prompt', {
        sessionId: this.nativeSessionId,
        prompt: [{ type: 'text', text: this.options.prompt }],
      }, 'prompt'),
    ], []);
  }

  private translateUpdate(value: unknown): ActoviqBridgeJsonEvent[] {
    // Current Reasonix replays persisted transcript records as session/update
    // notifications while session/load is still pending. History integration
    // owns those records; this run state machine only emits the new live turn.
    if (!this.promptStarted) return [];
    if (!isRecord(value)) return [];
    const sessionId = stringValue(value.sessionId);
    if (this.nativeSessionId && sessionId && sessionId !== this.nativeSessionId) return [];
    const update = isRecord(value.update) ? value.update : undefined;
    if (!update) return [];
    const updateType = stringValue(update.sessionUpdate);

    if (updateType === 'agent_message_chunk' || updateType === 'agent_thought_chunk') {
      const text = textFromContent(update.content);
      const metadata = isRecord(update.metadata) ? update.metadata : undefined;
      const updateError = metadata && isRecord(metadata.error) ? metadata.error : undefined;
      if (updateError) {
        this.lastError = errorMessage(updateError, 'Reasonix turn failed');
      }
      if (!text) return [];
      if (updateType === 'agent_message_chunk') this.assistantText += text;
      return [bridgeEvent('stream_event', {
        session_id: this.nativeSessionId ?? sessionId ?? '',
        event: {
          type: 'content_block_delta',
          index: updateType === 'agent_message_chunk' ? 0 : 1,
          delta: updateType === 'agent_message_chunk'
            ? { type: 'text_delta', text }
            : { type: 'thinking_delta', thinking: text },
        },
      })];
    }

    if (updateType === 'tool_call') {
      const id = stringValue(update.toolCallId);
      if (!id || this.emittedToolCalls.has(id)) return [];
      this.emittedToolCalls.add(id);
      const name = stringValue(update.title) ?? stringValue(update.kind) ?? 'Tool';
      return [bridgeEvent('assistant', {
        session_id: this.nativeSessionId ?? sessionId ?? '',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id,
            name,
            input: toolInput(update.rawInput),
          }],
        },
      })];
    }

    if (updateType === 'tool_call_update') {
      const id = stringValue(update.toolCallId);
      const status = String(update.status ?? '').toLowerCase();
      const terminal = ['completed', 'failed', 'error', 'cancelled', 'denied'].includes(status);
      if (!id || this.emittedToolResults.has(id) || !terminal) {
        return [];
      }
      this.emittedToolResults.add(id);
      return [bridgeEvent('user', {
        session_id: this.nativeSessionId ?? sessionId ?? '',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: toolResultText(update.content),
            is_error: ['failed', 'error', 'cancelled', 'denied'].includes(status),
          }],
        },
      })];
    }

    return [];
  }

  private permissionResponse(
    id: ReasonixAcpJsonRpcId,
    value: unknown,
  ): ReasonixAcpJsonRpcRecord {
    const params = isRecord(value) ? value : {};
    const sessionId = stringValue(params.sessionId);
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const options = parsePermissionOptions(params.options);
    const sameSession = !this.nativeSessionId || !sessionId || sessionId === this.nativeSessionId;
    const allow = sameSession && (
      this.options.permissionMode === 'bypassPermissions'
      || (this.options.permissionMode === 'acceptEdits' && isEditPermission(toolCall))
    );
    const desiredKind = allow ? 'allow_once' : 'reject_once';
    const selected = options.find(option => option.kind === desiredKind);

    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      result: {
        outcome: selected
          ? { outcome: 'selected', optionId: selected.optionId }
          : { outcome: 'cancelled' },
      },
    };
  }

  private handlePromptResult(value: unknown): ReasonixAcpHandleResult {
    const result = isRecord(value) ? value : {};
    const stopReason = stringValue(result.stopReason)
      ?? stringValue(result.stop_reason)
      ?? 'end_turn';
    const isError = stopReason !== 'end_turn';
    const events: ActoviqBridgeJsonEvent[] = [];
    if (this.assistantText) {
      events.push(bridgeEvent('assistant', {
        session_id: this.nativeSessionId ?? '',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: this.assistantText }],
        },
      }));
    }
    events.push(bridgeEvent('result', {
      subtype: isError ? 'error' : 'success',
      session_id: this.nativeSessionId ?? '',
      is_error: isError,
      result: isError
        ? this.lastError ?? (stopReason === 'cancelled'
          ? 'Reasonix turn cancelled.'
          : 'Reasonix turn failed.')
        : this.assistantText,
      stop_reason: stopReason,
      num_turns: 1,
    }));
    this.completed = true;
    return this.result([], events);
  }

  private fail(message: string): ReasonixAcpHandleResult {
    this.completed = true;
    this.pending = undefined;
    return this.result([], [bridgeEvent('result', {
      subtype: 'error',
      session_id: this.nativeSessionId ?? '',
      is_error: true,
      result: message,
      stop_reason: 'error',
      num_turns: 1,
    })]);
  }

  private result(
    outbound: ReasonixAcpJsonRpcRecord[],
    events: ActoviqBridgeJsonEvent[],
  ): ReasonixAcpHandleResult {
    return {
      outbound,
      events,
      done: this.completed,
      ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}),
    };
  }

  private resetTurn(): void {
    this.completed = false;
    this.cancelSent = false;
    this.promptStarted = false;
    this.pending = undefined;
    this.assistantText = '';
    this.lastError = undefined;
    this.emittedToolCalls.clear();
    this.emittedToolResults.clear();
  }

  private validateBudget(value: number | undefined): void {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError('maxBudgetUsd must be a finite non-negative number.');
    }
  }
}

export function createReasonixAcpSession(
  options: CreateReasonixAcpSessionOptions,
): ReasonixAcpSession {
  return new ReasonixAcpSessionState(options);
}
