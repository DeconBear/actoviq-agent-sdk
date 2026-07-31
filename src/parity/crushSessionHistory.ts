import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import type {
  ExternalCliSession,
  ExternalCliSessionMessage,
  ExternalCliSessionSummary,
  ExternalCliToolMetadata,
} from './externalCliSessions.js';
import {
  findExecutableOnPath,
  resolveExecutableInvocation,
} from './bridgeExecResolver.js';
import { terminateBridgeProcessTree } from './bridgeProviders.js';

const CRUSH_SESSION_REFERENCE_NAMESPACE = 'hadamard-crush-session:';
const CRUSH_SESSION_REFERENCE_V1_PREFIX = `${CRUSH_SESSION_REFERENCE_NAMESPACE}v1:`;
const CRUSH_SESSION_REFERENCE_V2_PREFIX = `${CRUSH_SESSION_REFERENCE_NAMESPACE}v2:`;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 4_000;
const MAX_STDERR_BYTES = 64 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface CrushHistoryCommandRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxOutputBytes: number;
  shell: false;
}

export interface CrushHistoryCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CrushHistoryCommandRunner = (
  request: CrushHistoryCommandRequest,
) => Promise<CrushHistoryCommandResult>;

export interface CrushSessionHistoryOptions {
  executable?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxMessages?: number;
  offset?: number;
  limit?: number;
  commandRunner?: CrushHistoryCommandRunner;
  /** Stable Hadamard-managed profile identity encoded into virtual references. */
  managedProfileId?: string;
}

export interface CrushSessionReferenceDetails {
  nativeSessionId: string;
  managedProfileId?: string;
}

export interface CrushSessionSummary
  extends Omit<ExternalCliSessionSummary, 'runtime'> {
  runtime: 'crush';
  /** `crush session list --json` does not include this count. */
  messageCountKnown: boolean;
}

export interface CrushSessionHistory
  extends Omit<ExternalCliSession, 'summary'> {
  summary: CrushSessionSummary;
}

/** Returns summaries from Crush's official per-project JSON session index. */
export async function listCrushSessionHistory(
  options: CrushSessionHistoryOptions = {},
): Promise<CrushSessionSummary[]> {
  const result = await runHistoryCommand(['session', 'list', '--json'], options);
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];

  const parsed = parseJson(result.stdout, 'Crush session list');
  if (!Array.isArray(parsed)) {
    throw new Error('Crush session list returned an unexpected JSON shape.');
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const summaries = parsed.flatMap(value => {
    const record = asRecord(value);
    const sessionId = record ? exactCrushSessionId(record.uuid) : undefined;
    const createdAt = record ? normalizeTimestamp(record.created) : undefined;
    const updatedAt = record ? normalizeTimestamp(record.modified) : undefined;
    if (!record || !sessionId || !createdAt || !updatedAt) return [];
    return [{
      runtime: 'crush' as const,
      nativeSessionId: sessionId,
      title: normalizeTitle(stringValue(record.title) ?? sessionId),
      cwd,
      createdAt,
      updatedAt,
      messageCount: 0,
      messageCountKnown: false,
      path: createCrushSessionReference(sessionId, options.managedProfileId),
    }];
  });

  summaries.sort((left, right) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || left.nativeSessionId.localeCompare(right.nativeSessionId));
  const offset = nonNegativeInteger(options.offset, 0);
  const limit = options.limit == null
    ? summaries.length
    : nonNegativeInteger(options.limit, summaries.length);
  return summaries.slice(offset, offset + limit);
}

/** Reads one exact session selected from a previously returned virtual reference. */
export async function readCrushSessionHistory(
  reference: string,
  options: CrushSessionHistoryOptions = {},
): Promise<CrushSessionHistory | undefined> {
  const requested = parseCrushSessionReferenceDetails(reference);
  if (!requested || requested.managedProfileId !== options.managedProfileId) return undefined;
  const requestedId = requested.nativeSessionId;

  const result = await runHistoryCommand(
    ['session', 'show', requestedId, '--json'],
    options,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;

  const output = asRecord(parseJson(result.stdout, 'Crush session detail'));
  const meta = output && asRecord(output.meta);
  const returnedId = meta ? exactCrushSessionId(meta.uuid) : undefined;
  if (!output || !meta || returnedId !== requestedId) {
    throw new Error('Crush session detail did not match the exact requested session.');
  }

  const rawMessages = Array.isArray(output.messages) ? output.messages : [];
  const maxMessages = positiveInteger(options.maxMessages, DEFAULT_MAX_MESSAGES);
  const truncated = rawMessages.length > maxMessages;
  const messages = rawMessages
    .slice(0, maxMessages)
    .flatMap(value => parseCrushMessage(value));
  const createdAt = normalizeTimestamp(meta.created)
    ?? messages[0]?.timestamp
    ?? new Date(0).toISOString();
  const updatedAt = normalizeTimestamp(meta.modified)
    ?? messages.at(-1)?.timestamp
    ?? createdAt;
  const summary: CrushSessionSummary = {
    runtime: 'crush',
    nativeSessionId: requestedId,
    title: normalizeTitle(stringValue(meta.title) ?? requestedId),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    createdAt,
    updatedAt,
    messageCount: rawMessages.length,
    messageCountKnown: true,
    path: reference,
    ...(truncated ? { truncated: true } : {}),
  };
  return {
    summary,
    messages,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Opaque path replacement stored in ExternalCliSessionSummary.path. */
export function createCrushSessionReference(
  sessionId: string,
  managedProfileId?: string,
): string {
  const exactId = requireExactCrushSessionId(sessionId);
  if (managedProfileId === undefined) {
    return CRUSH_SESSION_REFERENCE_V1_PREFIX
      + Buffer.from(exactId, 'utf8').toString('base64url');
  }
  const exactProfileId = requireExactManagedProfileId(managedProfileId);
  return CRUSH_SESSION_REFERENCE_V2_PREFIX
    + Buffer.from(`${exactProfileId}:${exactId}`, 'utf8').toString('base64url');
}

/** True for the Crush namespace, including malformed references that must not hit fs APIs. */
export function isCrushSessionReference(reference: string): boolean {
  return reference.startsWith(CRUSH_SESSION_REFERENCE_NAMESPACE);
}

export function parseCrushSessionReference(reference: string): string | undefined {
  return parseCrushSessionReferenceDetails(reference)?.nativeSessionId;
}

export function parseCrushSessionReferenceDetails(
  reference: string,
): CrushSessionReferenceDetails | undefined {
  const prefix = reference.startsWith(CRUSH_SESSION_REFERENCE_V1_PREFIX)
    ? CRUSH_SESSION_REFERENCE_V1_PREFIX
    : reference.startsWith(CRUSH_SESSION_REFERENCE_V2_PREFIX)
      ? CRUSH_SESSION_REFERENCE_V2_PREFIX
      : undefined;
  if (!prefix) return undefined;
  const encoded = reference.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) return undefined;
  if (prefix === CRUSH_SESSION_REFERENCE_V1_PREFIX) {
    const nativeSessionId = exactCrushSessionId(decoded);
    return nativeSessionId ? { nativeSessionId } : undefined;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.indexOf(':', separator + 1) >= 0) return undefined;
  const managedProfileId = exactManagedProfileId(decoded.slice(0, separator));
  const nativeSessionId = exactCrushSessionId(decoded.slice(separator + 1));
  return managedProfileId && nativeSessionId
    ? { nativeSessionId, managedProfileId }
    : undefined;
}

export const defaultCrushHistoryCommandRunner: CrushHistoryCommandRunner = async request => {
  const resolvedExecutable = path.isAbsolute(request.executable)
    ? request.executable
    : await findExecutableOnPath(request.executable) ?? request.executable;
  const invocation = await resolveExecutableInvocation(resolvedExecutable, request.args);

  return new Promise<CrushHistoryCommandResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.file, invocation.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new Error('Unable to start the Crush session history command.'));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error('Crush session history command timed out.'));
    }, request.timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminateBridgeProcessTree(child).finally(() => reject(error));
    };

    child.stdout?.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > request.maxOutputBytes) {
        fail(new Error('Crush session history output exceeded its safety limit.'));
        return;
      }
      stdout.push(bytes);
    });
    child.stderr?.on('data', chunk => {
      if (settled || stderrBytes >= MAX_STDERR_BYTES) return;
      const bytes = Buffer.from(chunk);
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      stderr.push(bytes.subarray(0, remaining));
      stderrBytes += Math.min(bytes.length, remaining);
    });
    child.once('error', () => {
      fail(new Error('Unable to start the Crush session history command.'));
    });
    child.once('close', exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? 1,
      });
    });
  });
};

async function runHistoryCommand(
  args: string[],
  options: CrushSessionHistoryOptions,
): Promise<CrushHistoryCommandResult> {
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const request: CrushHistoryCommandRequest = {
    executable: options.executable?.trim() || 'crush',
    args,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    env: { ...process.env, ...(options.env ?? {}) },
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes,
    shell: false,
  };
  const result = await (options.commandRunner ?? defaultCrushHistoryCommandRunner)(request);
  if (Buffer.byteLength(result.stdout, 'utf8') > maxOutputBytes) {
    throw new Error('Crush session history output exceeded its safety limit.');
  }
  return result;
}

function parseCrushMessage(value: unknown): ExternalCliSessionMessage[] {
  const message = asRecord(value);
  const role = message ? crushRole(message.role) : undefined;
  if (!message || !role) return [];

  const textParts: string[] = [];
  const tools: ExternalCliToolMetadata[] = [];
  for (const valuePart of Array.isArray(message.parts) ? message.parts : []) {
    const part = asRecord(valuePart);
    if (!part) continue;
    const type = stringValue(part.type);
    if (type === 'text' && typeof part.text === 'string' && part.text) {
      textParts.push(part.text);
      continue;
    }
    if (type === 'reasoning' && typeof part.thinking === 'string' && part.thinking) {
      textParts.push(part.thinking);
      continue;
    }
    if (type === 'tool_call') {
      tools.push({
        kind: 'call',
        id: stringValue(part.tool_call_id) ?? stringValue(part.id),
        name: stringValue(part.name),
        input: parseToolInput(part.input),
      });
      continue;
    }
    if (type === 'tool_result') {
      const output = stringValue(part.content) ?? '';
      tools.push({
        kind: 'result',
        id: stringValue(part.tool_call_id),
        name: stringValue(part.name),
        output,
        isError: part.is_error === true,
      });
      if (output) textParts.push(output);
    }
  }
  if (textParts.length === 0 && tools.length === 0) return [];
  return [{
    role,
    text: textParts.join('\n'),
    timestamp: normalizeTimestamp(message.created),
    model: stringValue(message.model),
    ...(tools.length ? { tools } : {}),
  }];
}

function crushRole(value: unknown): ExternalCliSessionMessage['role'] | undefined {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool'
    ? value
    : undefined;
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

function exactCrushSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function requireExactCrushSessionId(value: string): string {
  const sessionId = exactCrushSessionId(value);
  if (!sessionId) throw new TypeError('Crush history requires an exact UUID session id.');
  return sessionId;
}

function exactManagedProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && MANAGED_PROFILE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function requireExactManagedProfileId(value: string): string {
  const profileId = exactManagedProfileId(value);
  if (!profileId) {
    throw new TypeError('Crush history requires an exact managed profile id.');
  }
  return profileId;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value != null && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value != null && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
