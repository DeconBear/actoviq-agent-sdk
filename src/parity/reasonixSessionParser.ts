import path from 'node:path';

export type ReasonixSessionMessageRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'think'
  | 'system';

export interface ReasonixSessionToolMetadata {
  kind: 'call' | 'result';
  id?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

export interface ReasonixSessionMessage {
  role: ReasonixSessionMessageRole;
  text: string;
  timestamp?: string;
  model?: string;
  tools?: ReasonixSessionToolMetadata[];
}

export interface ParsedReasonixSession {
  nativeSessionId?: string;
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  activeTranscript?: string;
  messages: ReasonixSessionMessage[];
  /** Recognized messages within the bounded record scan, including unretained ones. */
  messageCount: number;
  recordsScanned: number;
  truncated: boolean;
}

export interface ParseReasonixSessionOptions {
  filePath?: string;
  metadata?: string | Record<string, unknown>;
  nativeSessionId?: string;
  title?: string;
  cwd?: string;
  model?: string;
  fileCreatedAt?: string | number | Date;
  fileUpdatedAt?: string | number | Date;
  maxRecords?: number;
  maxMessages?: number;
  maxRecordChars?: number;
  maxTextChars?: number;
  maxToolPayloadChars?: number;
}

export type ReasonixSessionJsonlRecord = string | Record<string, unknown>;

export type ReasonixSessionRootEnvironment = Readonly<Record<string, string | undefined>>;

interface ParseLimits {
  maxRecords: number;
  maxMessages: number;
  maxRecordChars: number;
  maxTextChars: number;
  maxToolPayloadChars: number;
}

interface ParseState {
  messages: ReasonixSessionMessage[];
  messageCount: number;
  recordsScanned: number;
  retainedTextChars: number;
  truncated: boolean;
  nativeSessionId?: string;
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  activeTranscript?: string;
  firstUserText?: string;
  firstAssistantText?: string;
}

const DEFAULT_MAX_RECORDS = 8_000;
const DEFAULT_MAX_MESSAGES = 4_000;
const DEFAULT_MAX_RECORD_CHARS = 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 2 * 1024 * 1024;
const DEFAULT_MAX_TOOL_PAYLOAD_CHARS = 64 * 1024;
const MAX_TOOLS_PER_MESSAGE = 128;
const MAX_TITLE_CHARS = 160;
const MAX_IDENTIFIER_CHARS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedString(value: unknown, maxChars = MAX_IDENTIFIER_CHARS): string | undefined {
  const text = stringValue(value)?.trim();
  if (!text) return undefined;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function parseMetadata(
  value: ParseReasonixSessionOptions['metadata'],
  maxChars: number,
): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  if (value.length > maxChars) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTimestamp(value: unknown): string | undefined {
  let milliseconds: number;
  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return undefined;
  }
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function earlierTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function timestampFromRecord(record: Record<string, unknown>): string | undefined {
  return normalizeTimestamp(
    record.timestamp
      ?? record.createdAt
      ?? record.created_at
      ?? record.time,
  );
}

function normalizeTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= MAX_TITLE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_CHARS - 3)}...`;
}

function sessionIdFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const fileName = path.basename(filePath, path.extname(filePath));
  return boundedString(fileName);
}

function safeActiveTranscript(value: unknown): string | undefined {
  const name = boundedString(value, 4 * 1024);
  if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
    return undefined;
  }
  return name.toLowerCase().endsWith('.jsonl') ? name : undefined;
}

function normalizeRole(value: unknown): ReasonixSessionMessageRole | undefined {
  switch (value) {
    case 'user':
    case 'assistant':
    case 'tool':
    case 'system':
      return value;
    case 'think':
    case 'thinking':
    case 'reasoning':
    case 'agent_thought_chunk':
      return 'think';
    case 'assistant_final':
      return 'assistant';
    case 'tool_result':
      return 'tool';
    default:
      return undefined;
  }
}

function visibleText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(visibleText).filter(Boolean).join('\n').trim();
  }
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text.trim();
  return visibleText(value.content ?? value.output ?? value.result);
}

function parseRecord(value: ReasonixSessionJsonlRecord, limits: ParseLimits): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  const line = value.trim();
  if (!line || line.length > limits.maxRecordChars) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function* jsonlRecords(
  records: string | Iterable<ReasonixSessionJsonlRecord>,
): Iterable<ReasonixSessionJsonlRecord> {
  if (typeof records !== 'string') {
    yield* records;
    return;
  }
  let start = 0;
  while (start <= records.length) {
    const newline = records.indexOf('\n', start);
    if (newline < 0) {
      if (start < records.length) yield records.slice(start).replace(/\r$/u, '');
      return;
    }
    yield records.slice(start, newline).replace(/\r$/u, '');
    start = newline + 1;
  }
}

function boundedPayload(
  value: unknown,
  state: ParseState,
  limits: ParseLimits,
): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length <= limits.maxToolPayloadChars) return value;
    state.truncated = true;
    return `${value.slice(0, limits.maxToolPayloadChars - 3)}...`;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length <= limits.maxToolPayloadChars) return value;
    state.truncated = true;
    return `${serialized.slice(0, limits.maxToolPayloadChars - 3)}...`;
  } catch {
    state.truncated = true;
    return String(value).slice(0, limits.maxToolPayloadChars);
  }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toolCallsFromMessage(
  value: unknown,
  state: ParseState,
  limits: ParseLimits,
): ReasonixSessionToolMetadata[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_TOOLS_PER_MESSAGE) state.truncated = true;
  return value.slice(0, MAX_TOOLS_PER_MESSAGE).flatMap(call => {
    if (!isRecord(call)) return [];
    const fn = isRecord(call.function) ? call.function : undefined;
    const name = boundedString(call.name ?? fn?.name);
    const id = boundedString(call.id ?? call.call_id);
    const rawInput = call.arguments ?? fn?.arguments ?? call.input;
    return [{
      kind: 'call' as const,
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(rawInput !== undefined
        ? { input: boundedPayload(parseArguments(rawInput), state, limits) }
        : {}),
    }];
  });
}

function toolResultFromMessage(
  message: Record<string, unknown>,
  text: string,
): ReasonixSessionToolMetadata {
  const id = boundedString(message.tool_call_id ?? message.toolCallId ?? message.call_id);
  const name = boundedString(message.name ?? message.toolName ?? message.tool_name);
  const status = String(message.status ?? '').toLowerCase();
  const isError = booleanValue(message.is_error ?? message.isError)
    ?? ['failed', 'error', 'cancelled', 'denied'].includes(status);
  return {
    kind: 'result',
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(text ? { output: text } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function pushMessage(
  state: ParseState,
  limits: ParseLimits,
  message: ReasonixSessionMessage,
): void {
  const hasTools = Boolean(message.tools?.length);
  if (!message.text && !hasTools) return;
  state.messageCount += 1;

  if (message.role === 'user' && message.text && !state.firstUserText) {
    state.firstUserText = message.text.slice(0, MAX_TITLE_CHARS * 2);
  } else if (message.role === 'assistant' && message.text && !state.firstAssistantText) {
    state.firstAssistantText = message.text.slice(0, MAX_TITLE_CHARS * 2);
  }

  if (state.messages.length >= limits.maxMessages) {
    state.truncated = true;
    return;
  }

  const remaining = Math.max(0, limits.maxTextChars - state.retainedTextChars);
  let text = message.text;
  if (text.length > remaining) {
    text = remaining > 3 ? `${text.slice(0, remaining - 3)}...` : text.slice(0, remaining);
    state.truncated = true;
  }
  state.retainedTextChars += text.length;
  if (!text && !hasTools) return;
  state.messages.push({ ...message, text });
}

function rememberRecordMetadata(record: Record<string, unknown>, state: ParseState): void {
  state.nativeSessionId ??= boundedString(record.sessionId ?? record.session_id ?? record.id);
  state.title ??= normalizeTitle(boundedString(record.title ?? record.summary, MAX_TITLE_CHARS));
  state.cwd ??= boundedString(record.cwd ?? record.workspace ?? record.rootDir, 32 * 1024);
  state.model = boundedString(record.model ?? record.modelId) ?? state.model;
  const timestamp = timestampFromRecord(record);
  state.createdAt = earlierTimestamp(state.createdAt, timestamp);
  state.updatedAt = laterTimestamp(state.updatedAt, timestamp);
}

function consumeMessageRecord(
  record: Record<string, unknown>,
  state: ParseState,
  limits: ParseLimits,
): void {
  rememberRecordMetadata(record, state);

  if (record.type === 'model_change') {
    state.model = boundedString(record.modelId ?? record.model) ?? state.model;
    return;
  }
  if (record.type === 'summary' || record.type === 'session' || record.type === 'session_info') {
    return;
  }

  const nested = isRecord(record.message) ? record.message : undefined;
  const message = nested && normalizeRole(nested.role) ? nested : record;
  const role = normalizeRole(message.role) ?? normalizeRole(record.type);
  if (!role) return;

  const timestamp = timestampFromRecord(record) ?? timestampFromRecord(message);
  const model = boundedString(message.model ?? record.model) ?? state.model;
  const content = message.content ?? message.text ?? message.output ?? message.result;

  if (role === 'assistant') {
    const reasoning = visibleText(
      message.reasoning_content
        ?? message.reasoningContent
        ?? message.thinking
        ?? message.reasoning,
    );
    if (reasoning) {
      pushMessage(state, limits, {
        role: 'think',
        text: reasoning,
        ...(timestamp ? { timestamp } : {}),
        ...(model ? { model } : {}),
      });
    }
    const tools = toolCallsFromMessage(
      message.tool_calls ?? message.toolCalls ?? record.tool_calls,
      state,
      limits,
    );
    pushMessage(state, limits, {
      role,
      text: visibleText(content),
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
      ...(tools.length ? { tools } : {}),
    });
    return;
  }

  if (role === 'tool') {
    const text = visibleText(content);
    const result = toolResultFromMessage(message, text);
    if (result.output) {
      result.output = boundedPayload(result.output, state, limits) as string;
    }
    pushMessage(state, limits, {
      role,
      text,
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
      tools: [result],
    });
    return;
  }

  pushMessage(state, limits, {
    role,
    text: visibleText(content),
    ...(timestamp ? { timestamp } : {}),
    ...(model ? { model } : {}),
  });
}

export function parseReasonixSessionJsonl(
  records: string | Iterable<ReasonixSessionJsonlRecord>,
  options: ParseReasonixSessionOptions = {},
): ParsedReasonixSession {
  const limits: ParseLimits = {
    maxRecords: positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS),
    maxMessages: positiveInteger(options.maxMessages, DEFAULT_MAX_MESSAGES),
    maxRecordChars: positiveInteger(options.maxRecordChars, DEFAULT_MAX_RECORD_CHARS),
    maxTextChars: positiveInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS),
    maxToolPayloadChars: positiveInteger(
      options.maxToolPayloadChars,
      DEFAULT_MAX_TOOL_PAYLOAD_CHARS,
    ),
  };
  const metadata = parseMetadata(options.metadata, limits.maxRecordChars);
  const metadataCreated = normalizeTimestamp(metadata.createdAt ?? metadata.created_at);
  const metadataUpdated = normalizeTimestamp(metadata.updatedAt ?? metadata.updated_at);
  const state: ParseState = {
    messages: [],
    messageCount: 0,
    recordsScanned: 0,
    retainedTextChars: 0,
    truncated: false,
    nativeSessionId: boundedString(
      options.nativeSessionId
        ?? metadata.sessionId
        ?? metadata.session_id
        ?? metadata.id
        ?? sessionIdFromPath(options.filePath),
    ),
    title: normalizeTitle(options.title ?? stringValue(metadata.title ?? metadata.summary)),
    cwd: boundedString(options.cwd ?? metadata.cwd ?? metadata.workspace, 32 * 1024),
    model: boundedString(options.model ?? metadata.model ?? metadata.modelId),
    createdAt: metadataCreated ?? normalizeTimestamp(options.fileCreatedAt),
    updatedAt: metadataUpdated ?? normalizeTimestamp(options.fileUpdatedAt),
    activeTranscript: safeActiveTranscript(metadata.activeTranscript),
  };

  for (const item of jsonlRecords(records)) {
    if (state.recordsScanned >= limits.maxRecords) {
      state.truncated = true;
      break;
    }
    state.recordsScanned += 1;
    if (typeof item === 'string' && item.trim().length > limits.maxRecordChars) {
      state.truncated = true;
      continue;
    }
    const record = parseRecord(item, limits);
    if (record) consumeMessageRecord(record, state, limits);
  }

  const fallbackTitle = state.firstUserText
    ?? state.firstAssistantText
    ?? state.nativeSessionId;
  return {
    ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}),
    ...(normalizeTitle(state.title ?? fallbackTitle)
      ? { title: normalizeTitle(state.title ?? fallbackTitle) }
      : {}),
    ...(state.cwd ? { cwd: state.cwd } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.createdAt ? { createdAt: state.createdAt } : {}),
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    ...(state.activeTranscript ? { activeTranscript: state.activeTranscript } : {}),
    messages: state.messages,
    messageCount: state.messageCount,
    recordsScanned: state.recordsScanned,
    truncated: state.truncated,
  };
}

function envValue(
  env: ReasonixSessionRootEnvironment,
  name: string,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function expandRoot(
  value: string | undefined,
  homeDir: string,
  env: ReasonixSessionRootEnvironment,
): string | undefined {
  let expanded = value?.trim();
  if (!expanded) return undefined;
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gu, (_match, braced: string | undefined, plain: string | undefined, percent: string | undefined) =>
    envValue(env, braced ?? plain ?? percent ?? '') ?? '',
  );
  if (expanded === '~') {
    expanded = homeDir;
  } else if (/^~[\\/]/u.test(expanded)) {
    expanded = path.join(homeDir, expanded.slice(2));
  }
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.join(homeDir, expanded));
}

export function resolveReasonixSessionRoots(
  homeDir: string,
  env: ReasonixSessionRootEnvironment,
): string[] {
  const trimmedHome = homeDir.trim();
  if (!trimmedHome) throw new TypeError('homeDir is required.');
  const home = path.normalize(trimmedHome);
  const explicitHome = expandRoot(envValue(env, 'REASONIX_HOME'), home, env);
  const appData = expandRoot(envValue(env, 'APPDATA'), home, env);
  const reasonixHome = explicitHome
    ?? (appData ? path.join(appData, 'reasonix') : path.join(home, '.reasonix'));
  const stateHome = expandRoot(envValue(env, 'REASONIX_STATE_HOME'), home, env)
    ?? reasonixHome;
  const candidates = [
    path.join(stateHome, 'sessions'),
  ];

  // npm Reasonix v0.x always used ~/.reasonix/sessions. Preserve that root
  // beside the current Windows AppData location, or inside an explicit
  // REASONIX_HOME when REASONIX_STATE_HOME points elsewhere.
  const legacyHome = explicitHome ?? path.join(home, '.reasonix');
  candidates.push(path.join(legacyHome, 'sessions'));

  const seen = new Set<string>();
  return candidates.flatMap(candidate => {
    const normalized = path.normalize(candidate);
    const key = path.sep === '\\' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}
