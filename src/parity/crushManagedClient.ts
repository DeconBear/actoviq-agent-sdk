import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { request as nodeHttpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type {
  HadamardBridgeJsonEvent,
  HadamardBridgePermissionMode,
} from '../types.js';
import {
  findExecutableOnPath,
  IS_WINDOWS,
  resolveExecutableInvocation,
} from './bridgeExecResolver.js';
import { terminateManagedProcessTree } from './bridgeProcessTree.js';

const HEALTH_TIMEOUT_MS = 10_000;
const AGENT_READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const UNIX_SOCKET_PATH_LIMIT = 103;
const CRUSH_CONFIG_SCOPE_GLOBAL = 0;
const CRUSH_CONFIG_SCOPE_WORKSPACE = 1;
const SECRET_KEY_PATTERN =
  /(?:api.?key|access.?key|private.?key|token|authorization|password|secret|cookie|credential)/i;

type JsonRecord = Record<string, unknown>;

export interface CrushHttpRequestOptions {
  socketPath: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CrushHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array | string>;
}

export type CrushHttpRequest = (
  options: CrushHttpRequestOptions,
) => Promise<CrushHttpResponse>;

export type CrushSpawnFn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CrushLocalTransport {
  /** Value passed to `crush server --host`. TCP is deliberately unsupported. */
  serverHost: string;
  /** Local socket path passed to Node's `http.request({ socketPath })`. */
  socketPath: string;
  cleanup?: () => Promise<void>;
}

export interface CrushPermissionRequest extends JsonRecord {
  id: string;
  session_id: string;
  tool_call_id?: string;
  tool_name?: string;
  action?: string;
  path?: string;
}

export type CrushPermissionDecision = 'allow' | 'allow_session' | 'deny';

export interface RunCrushManagedOptions {
  executable?: string;
  /** Static argv inserted before `server`; used for node + script invocations. */
  executableArgs?: readonly string[];
  cwd: string;
  prompt: string;
  nativeSessionId?: string;
  /** Native model id selected for Crush's large/coder model. */
  model?: string;
  /** Native Crush provider id (for example `openai`, `anthropic`, or `openrouter`). */
  credentialProvider?: string;
  /** Optional provider credential applied through Crush's local server API. */
  apiKey?: string;
  /** Optional provider base URL applied through Crush's local server API. */
  baseURL?: string;
  permissionMode?: HadamardBridgePermissionMode;
  /** Child-process environment only. Values are redacted from events and stderr. */
  env?: Record<string, string>;
  /** Set false when `env` is already a complete, credential-sanitized environment. */
  inheritEnvironment?: boolean;
  signal?: AbortSignal;
  spawnFn?: CrushSpawnFn;
  httpRequest?: CrushHttpRequest;
  /** Optional UI decision seam. Without one, non-bypass modes fail closed. */
  permissionHandler?: (
    request: CrushPermissionRequest,
  ) => CrushPermissionDecision | Promise<CrushPermissionDecision>;
  /** Test/integration seam; production callers should use the private random default. */
  transportFactory?: () => Promise<CrushLocalTransport>;
  healthTimeoutMs?: number;
  agentReadyTimeoutMs?: number;
}

export interface CrushManagedRunResult {
  sessionId: string;
  stderr: string;
  exitCode: number | null;
}

interface CrushWorkspace {
  id: string;
}

interface CrushSession {
  id: string;
}

interface ParsedCrushEvent {
  kind: string;
  envelope: JsonRecord;
  inner: JsonRecord;
  data: JsonRecord;
}

interface EventScope {
  workspaceId: string;
  clientId: string;
  sessionId: string;
  runId: string;
}

interface MessageState {
  text: string;
  textByMessage: Map<string, string>;
  reasoningByMessage: Map<string, string>;
  toolCalls: Map<string, string>;
  toolResults: Set<string>;
}

interface EventStreamResult {
  isError: boolean;
}

/**
 * Runs Crush through its official local server protocol (v0.80-v0.84).
 * The prompt is sent in a JSON request body and never appears in argv.
 */
export async function runCrushManaged(
  options: RunCrushManagedOptions,
  onEvent: (event: HadamardBridgeJsonEvent) => void | Promise<void>,
): Promise<CrushManagedRunResult> {
  validateRunOptions(options);
  throwIfAborted(options.signal);

  const transport = await (options.transportFactory ?? createPrivateCrushTransport)();
  assertCrushLocalTransport(transport);

  const spawnFn = options.spawnFn ?? defaultSpawn;
  const httpRequest = options.httpRequest ?? defaultCrushHttpRequest;
  const executable = options.executable?.trim() || 'crush';
  const secrets = secretValues(options.env, options.apiKey == null ? [] : [options.apiKey]);
  const clientId = randomUUID();
  const runId = randomUUID();
  const stderr = createStderrCollector(secrets);
  const sseController = new AbortController();

  let child: ChildProcess | undefined;
  let workspaceId: string | undefined;
  let sessionId: string | undefined;
  let runSubmitted = false;
  let runCompleted = false;
  let streamIsError = false;
  let childSpawnError: Error | undefined;

  const emit = async (event: HadamardBridgeJsonEvent): Promise<void> => {
    await onEvent(redactEvent(event, secrets));
  };

  try {
    const invocation = await resolveCrushInvocation(
      executable,
      [...(options.executableArgs ?? []), 'server', '--host', transport.serverHost],
    );
    child = spawnFn(
      invocation.file,
      invocation.args,
      {
        cwd: options.cwd,
        env: options.inheritEnvironment === false
          ? { ...(options.env ?? {}) }
          : { ...process.env, ...(options.env ?? {}) },
        shell: false,
        detached: !IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    stderr.attach(child);
    child.once('error', error => {
      childSpawnError = error;
    });

    await raceWithAbort(
      waitForHealth(
        httpRequest,
        transport.socketPath,
        child,
        () => childSpawnError,
        options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
        options.signal,
      ),
      options.signal,
    );

    const workspace = await jsonRequest<CrushWorkspace>(httpRequest, {
      socketPath: transport.socketPath,
      method: 'POST',
      path: '/v1/workspaces',
      body: JSON.stringify({ path: options.cwd, client_id: clientId }),
      signal: options.signal,
    }, [200]);
    workspaceId = requiredIdentifier(workspace.id, 'Crush workspace id');

    await configureCrushWorkspace(
      httpRequest,
      transport.socketPath,
      workspaceId,
      options,
    );

    sessionId = options.nativeSessionId
      ? await resolveExistingSession(
        httpRequest,
        transport.socketPath,
        workspaceId,
        options.nativeSessionId,
        options.signal,
      )
      : requiredIdentifier((await jsonRequest<CrushSession>(httpRequest, {
        socketPath: transport.socketPath,
        method: 'POST',
        path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        body: JSON.stringify({ title: 'Hadamard managed run' }),
        signal: options.signal,
      }, [200])).id, 'Crush session id');

    const permissionMode = options.permissionMode ?? 'default';
    await emptyRequest(httpRequest, {
      socketPath: transport.socketPath,
      method: 'POST',
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/permissions/skip`,
      body: JSON.stringify({ skip: permissionMode === 'bypassPermissions' }),
      signal: options.signal,
    }, [200]);

    await emptyRequest(httpRequest, {
      socketPath: transport.socketPath,
      method: 'POST',
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent/init`,
      signal: options.signal,
    }, [200]);
    await raceWithAbort(waitForAgentReady(
      httpRequest,
      transport.socketPath,
      workspaceId,
      options.agentReadyTimeoutMs ?? AGENT_READY_TIMEOUT_MS,
      options.signal,
    ), options.signal);

    const streamResponse = await raceWithAbort(httpRequest({
      socketPath: transport.socketPath,
      method: 'GET',
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/events?client_id=${encodeURIComponent(clientId)}`,
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      signal: sseController.signal,
      timeoutMs: 0,
    }), options.signal);
    assertStatus(streamResponse, [200], 'subscribe to Crush events');

    await emptyRequest(httpRequest, {
      socketPath: transport.socketPath,
      method: 'POST',
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/current-session?client_id=${encodeURIComponent(clientId)}`,
      body: JSON.stringify({ session_id: sessionId }),
      signal: options.signal,
    }, [200]);

    await emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd: options.cwd,
      runtime: 'crush',
      permission_mode: permissionMode,
    });

    await emptyRequest(httpRequest, {
      socketPath: transport.socketPath,
      method: 'POST',
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent`,
      body: JSON.stringify({ session_id: sessionId, run_id: runId, prompt: options.prompt }),
      signal: options.signal,
    }, [200, 202]);
    runSubmitted = true;

    const streamResult = await raceWithAbort(consumeCrushEventStream({
      response: streamResponse,
      httpRequest,
      socketPath: transport.socketPath,
      permissionMode,
      permissionHandler: options.permissionHandler,
      scope: { workspaceId, clientId, sessionId, runId },
      emit,
      signal: sseController.signal,
    }), options.signal);
    runCompleted = true;
    streamIsError = streamResult.isError;
  } finally {
    // A submitted run must be canceled before its owning process tree is torn down.
    if (child && workspaceId && sessionId && runSubmitted && !runCompleted) {
      await bestEffortWithTimeout(emptyRequest(httpRequest, {
        socketPath: transport.socketPath,
        method: 'POST',
        path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/cancel`,
      }, [200]), CLEANUP_TIMEOUT_MS);
    }

    sseController.abort();

    if (child && workspaceId) {
      await bestEffortWithTimeout(emptyRequest(httpRequest, {
        socketPath: transport.socketPath,
        method: 'POST',
        path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/current-session?client_id=${encodeURIComponent(clientId)}`,
        body: JSON.stringify({ session_id: '' }),
      }, [200]), CLEANUP_TIMEOUT_MS);
    }
    if (child) {
      await bestEffortWithTimeout(emptyRequest(httpRequest, {
        socketPath: transport.socketPath,
        method: 'POST',
        path: '/v1/control',
        body: JSON.stringify({ command: 'shutdown' }),
      }, [200]), CLEANUP_TIMEOUT_MS);
      await terminateManagedProcessTree(child);
    }
    await transport.cleanup?.();
  }

  return {
    sessionId: requiredIdentifier(sessionId, 'Crush session id'),
    stderr: stderr.value(),
    exitCode: child?.exitCode ?? (streamIsError ? 1 : 0),
  };
}

/** Creates the private local-only transport used by production runs. */
export async function createPrivateCrushTransport(): Promise<CrushLocalTransport> {
  if (process.platform === 'win32') {
    const name = `hadamard-crush-${randomUUID()}`;
    return {
      serverHost: `npipe:////./pipe/${name}`,
      socketPath: `\\\\.\\pipe\\${name}`,
    };
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-crush-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'server.sock');
  if (Buffer.byteLength(socketPath, 'utf8') > UNIX_SOCKET_PATH_LIMIT) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('The private Crush Unix socket path exceeds the platform limit.');
  }
  return {
    serverHost: `unix://${socketPath}`,
    socketPath,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Rejects TCP and mismatched local socket descriptions. */
export function assertCrushLocalTransport(transport: CrushLocalTransport): void {
  if (transport.serverHost.startsWith('tcp://')) {
    throw new TypeError('Crush managed mode refuses TCP transports.');
  }
  if (transport.serverHost.startsWith('unix://')) {
    const expected = transport.serverHost.slice('unix://'.length);
    if (!path.isAbsolute(expected) || expected !== transport.socketPath) {
      throw new TypeError('Crush Unix transport must use one matching absolute socket path.');
    }
    return;
  }
  if (transport.serverHost.startsWith('npipe:////./pipe/')) {
    const name = transport.serverHost.slice('npipe:////./pipe/'.length);
    if (!name || transport.socketPath !== `\\\\.\\pipe\\${name}`) {
      throw new TypeError('Crush named-pipe transport has mismatched endpoints.');
    }
    return;
  }
  throw new TypeError('Crush managed mode requires a Unix socket or Windows named pipe.');
}

/** Deterministic, fail-closed mapping used when no UI permission handler is supplied. */
export function decideCrushPermission(
  mode: HadamardBridgePermissionMode,
  request: Pick<CrushPermissionRequest, 'tool_name'>,
): CrushPermissionDecision {
  if (mode === 'bypassPermissions') return 'allow';
  if (
    mode === 'acceptEdits'
    && request.tool_name != null
    && ['edit', 'write', 'multiedit'].includes(request.tool_name)
  ) {
    return 'allow_session';
  }
  return 'deny';
}

export const defaultCrushHttpRequest: CrushHttpRequest = options => new Promise((resolve, reject) => {
  const request = nodeHttpRequest({
    socketPath: options.socketPath,
    method: options.method,
    path: options.path,
    headers: options.headers,
    signal: options.signal,
  }, response => {
    resolve({
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      body: response,
    });
  });
  request.once('error', reject);
  if (options.timeoutMs !== 0) {
    request.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Crush HTTP request timed out: ${options.method} ${options.path}`));
    });
  }
  if (options.body != null) request.write(options.body);
  request.end();
});

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(executable, [...args], options);
}

async function resolveCrushInvocation(
  executable: string,
  args: string[],
): Promise<{ file: string; args: string[] }> {
  const configuredPath = path.isAbsolute(executable)
    ? executable
    : await findExecutableOnPath(executable) ?? executable;
  return resolveExecutableInvocation(configuredPath, args);
}

function validateRunOptions(options: RunCrushManagedOptions): void {
  if (!options.cwd || !path.isAbsolute(options.cwd)) {
    throw new TypeError('Crush managed mode requires an absolute cwd.');
  }
  if (typeof options.prompt !== 'string' || options.prompt.length === 0) {
    throw new TypeError('Crush managed mode requires a non-empty prompt.');
  }
  if (options.nativeSessionId != null) validateSessionId(options.nativeSessionId);
  if (options.model != null) validateCrushModel(options.model);
  if (options.credentialProvider != null) validateCrushProvider(options.credentialProvider);
  if (options.apiKey != null) validateCrushApiKey(options.apiKey);
  if (options.baseURL != null) validateCrushBaseURL(options.baseURL);
}

async function configureCrushWorkspace(
  httpRequest: CrushHttpRequest,
  socketPath: string,
  workspaceId: string,
  options: RunCrushManagedOptions,
): Promise<void> {
  if (
    options.model == null
    && options.apiKey == null
    && options.baseURL == null
  ) {
    return;
  }

  if (!options.credentialProvider) {
    throw new TypeError(
      'Crush managed model or API-key configuration requires an explicit native provider id.',
    );
  }
  const provider = validateCrushProvider(options.credentialProvider);
  const workspacePath = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  const modelScope = options.apiKey != null || options.baseURL != null
    ? CRUSH_CONFIG_SCOPE_GLOBAL
    : CRUSH_CONFIG_SCOPE_WORKSPACE;

  if (options.baseURL != null) {
    await emptyRequest(httpRequest, {
      socketPath,
      method: 'POST',
      path: `${workspacePath}/config/set`,
      body: JSON.stringify({
        scope: CRUSH_CONFIG_SCOPE_GLOBAL,
        key: `providers.${provider}.base_url`,
        value: validateCrushBaseURL(options.baseURL),
      }),
      signal: options.signal,
    }, [200]);
  }

  if (options.apiKey != null) {
    await emptyRequest(httpRequest, {
      socketPath,
      method: 'POST',
      path: `${workspacePath}/config/provider-key`,
      body: JSON.stringify({
        scope: CRUSH_CONFIG_SCOPE_GLOBAL,
        provider_id: provider,
        kind: 'string',
        api_key: validateCrushApiKey(options.apiKey),
      }),
      signal: options.signal,
    }, [200]);
  }

  if (options.model != null) {
    await emptyRequest(httpRequest, {
      socketPath,
      method: 'POST',
      path: `${workspacePath}/config/model`,
      body: JSON.stringify({
        scope: modelScope,
        model_type: 'large',
        model: {
          provider,
          model: validateCrushModel(options.model),
        },
      }),
      signal: options.signal,
    }, [200]);
  }
}

function validateCrushProvider(value: string): string {
  const provider = value.trim().toLowerCase();
  if (
    !provider
    || provider.length > 128
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(provider)
  ) {
    throw new TypeError('Crush credential provider must be a native provider id.');
  }
  return provider;
}

function validateCrushModel(value: string): string {
  const model = value.trim();
  if (
    !model
    || model.length > 512
    || /[\u0000-\u001f\u007f]/u.test(model)
  ) {
    throw new TypeError('Crush model must be a non-empty native model id.');
  }
  return model;
}

function validateCrushApiKey(value: string): string {
  if (!value.trim() || value.length > 16 * 1024 || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError('Crush API key must be a non-empty single-line value.');
  }
  return value;
}

function validateCrushBaseURL(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new TypeError('Crush base URL is missing or too long.');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError('Crush base URL must be an absolute HTTP(S) URL.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
  ) {
    throw new TypeError('Crush base URL must be an absolute HTTP(S) URL without credentials.');
  }
  return normalized.replace(/\/$/u, '');
}

async function resolveExistingSession(
  httpRequest: CrushHttpRequest,
  socketPath: string,
  workspaceId: string,
  nativeSessionId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const requested = validateSessionId(nativeSessionId);
  const session = await jsonRequest<CrushSession>(httpRequest, {
    socketPath,
    method: 'GET',
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(requested)}`,
    signal,
  }, [200]);
  const returned = requiredIdentifier(session.id, 'Crush session id');
  if (returned !== requested) {
    throw new Error('Crush returned a different session than the exact requested id.');
  }
  return returned;
}

function validateSessionId(value: string): string {
  const sessionId = value.trim();
  if (
    !sessionId
    || sessionId.length > 256
    || sessionId.startsWith('-')
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)
  ) {
    throw new TypeError('Crush session id must be a non-option identifier.');
  }
  return sessionId;
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

async function waitForHealth(
  httpRequest: CrushHttpRequest,
  socketPath: string,
  child: ChildProcess,
  getSpawnError: () => Error | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const deadline = Date.now() + normalizeTimeout(timeoutMs, HEALTH_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (getSpawnError()) {
      throw new Error('Crush server process failed to start.');
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Crush server exited before its health endpoint became ready.');
    }
    try {
      const response = await httpRequest({
        socketPath,
        method: 'GET',
        path: '/v1/health',
        signal,
        timeoutMs: 500,
      });
      if (response.statusCode === 200) {
        await discardBody(response.body);
        return;
      }
      await discardBody(response.body);
      lastError = new Error(`health status ${response.statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await abortableDelay(50, signal);
  }
  throw new Error(`Crush server health check timed out${lastError ? '.' : ''}`);
}

async function waitForAgentReady(
  httpRequest: CrushHttpRequest,
  socketPath: string,
  workspaceId: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const deadline = Date.now() + normalizeTimeout(timeoutMs, AGENT_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const info = await jsonRequest<{ is_ready?: boolean }>(httpRequest, {
        socketPath,
        method: 'GET',
        path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent`,
        signal,
        timeoutMs: 1_000,
      }, [200]);
      if (info.is_ready === true) return;
    } catch {
      // Initialization is asynchronous; retry until the bounded deadline.
    }
    await abortableDelay(50, signal);
  }
  throw new Error('Crush agent initialization timed out.');
}

function normalizeTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function consumeCrushEventStream(options: {
  response: CrushHttpResponse;
  httpRequest: CrushHttpRequest;
  socketPath: string;
  permissionMode: HadamardBridgePermissionMode;
  permissionHandler?: RunCrushManagedOptions['permissionHandler'];
  scope: EventScope;
  emit: (event: HadamardBridgeJsonEvent) => Promise<void>;
  signal: AbortSignal;
}): Promise<EventStreamResult> {
  const state: MessageState = {
    text: '',
    textByMessage: new Map(),
    reasoningByMessage: new Map(),
    toolCalls: new Map(),
    toolResults: new Set(),
  };

  try {
    for await (const data of parseSseData(options.response.body, options.signal)) {
      const parsed = parseCrushEvent(data);
      if (!parsed || !eventMatchesScope(parsed, options.scope)) continue;

      if (parsed.kind === 'message') {
        await normalizeMessage(parsed.data, options.scope, state, options.emit);
        continue;
      }

      if (parsed.kind === 'permission_request') {
        const permission = asPermissionRequest(parsed.data);
        if (!permission || permission.session_id !== options.scope.sessionId) continue;
        await options.emit({
          type: 'system',
          subtype: 'permission_request',
          session_id: options.scope.sessionId,
          permission: {
            id: permission.id,
            tool_call_id: permission.tool_call_id,
            tool_name: permission.tool_name,
            description: permission.description,
            action: permission.action,
            path: permission.path,
            params: permission.params,
          },
        });
        const decision = options.permissionHandler
          ? await options.permissionHandler(permission)
          : decideCrushPermission(options.permissionMode, permission);
        assertPermissionDecision(decision);
        await emptyRequest(options.httpRequest, {
          socketPath: options.socketPath,
          method: 'POST',
          path: `/v1/workspaces/${encodeURIComponent(options.scope.workspaceId)}/permissions/grant`,
          body: JSON.stringify({ permission, action: decision }),
          signal: options.signal,
        }, [200]);
        continue;
      }

      if (parsed.kind === 'permission_notification') {
        await options.emit({
          type: 'system',
          subtype: 'permission_notification',
          session_id: options.scope.sessionId,
          tool_call_id: stringValue(parsed.data.tool_call_id),
          granted: parsed.data.granted === true,
          denied: parsed.data.denied === true,
        });
        continue;
      }

      if (parsed.kind === 'agent_event' && parsed.data.type === 'error') {
        await options.emit({
          type: 'error',
          subtype: 'runtime_error',
          session_id: options.scope.sessionId,
          error: stringValue(parsed.data.error) ?? 'Crush agent failed.',
        });
        continue;
      }

      if (parsed.kind === 'run_complete') {
        const error = stringValue(parsed.data.error);
        const cancelled = parsed.data.cancelled === true;
        const isError = Boolean(error) || cancelled;
        if (isError) {
          await options.emit({
            type: 'error',
            subtype: cancelled ? 'cancelled' : 'runtime_error',
            session_id: options.scope.sessionId,
            error: error || 'Crush run was cancelled.',
          });
        }
        await options.emit({
          type: 'result',
          subtype: isError ? 'error' : 'success',
          session_id: options.scope.sessionId,
          is_error: isError,
          result: error || stringValue(parsed.data.text) || state.text,
          stop_reason: cancelled ? 'cancelled' : isError ? 'error' : 'end_turn',
          num_turns: 1,
        });
        return { isError };
      }
    }
  } catch (error) {
    if (options.signal.aborted) return { isError: true };
    throw error;
  }
  if (options.signal.aborted) return { isError: true };
  throw new Error('Crush event stream ended before a matching run_complete event.');
}

async function normalizeMessage(
  message: JsonRecord,
  scope: EventScope,
  state: MessageState,
  emit: (event: HadamardBridgeJsonEvent) => Promise<void>,
): Promise<void> {
  const role = stringValue(message.role);
  if (role !== 'assistant' && role !== 'tool') return;
  const messageId = stringValue(message.id) ?? 'crush-message';
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (let index = 0; index < parts.length; index += 1) {
    const wrapper = asRecord(parts[index]);
    if (!wrapper) continue;
    const type = stringValue(wrapper.type);
    const data = asRecord(wrapper.data) ?? wrapper;

    if (type === 'text' && typeof data.text === 'string') {
      const previous = state.textByMessage.get(messageId) ?? '';
      const delta = stringDelta(previous, data.text);
      state.textByMessage.set(messageId, data.text);
      state.text += delta;
      if (delta) {
        await emit({
          type: 'stream_event',
          session_id: scope.sessionId,
          event: {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: delta },
          },
        });
      }
      continue;
    }

    if (type === 'reasoning' && typeof data.thinking === 'string') {
      const previous = state.reasoningByMessage.get(messageId) ?? '';
      const delta = stringDelta(previous, data.thinking);
      state.reasoningByMessage.set(messageId, data.thinking);
      if (delta) {
        await emit({
          type: 'stream_event',
          session_id: scope.sessionId,
          event: {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: delta },
          },
        });
      }
      continue;
    }

    if (type === 'tool_call') {
      const id = stringValue(data.id);
      if (!id) continue;
      const fingerprint = JSON.stringify(data);
      const previous = state.toolCalls.get(id);
      if (previous === fingerprint) continue;
      state.toolCalls.set(id, fingerprint);
      if (data.finished === false) continue;
      await emit({
        type: 'assistant',
        session_id: scope.sessionId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id,
            name: stringValue(data.name) ?? 'tool',
            input: parseToolInput(data.input),
          }],
        },
      });
      continue;
    }

    if (type === 'tool_result') {
      const toolCallId = stringValue(data.tool_call_id) ?? 'crush-tool-unknown';
      const content = stringValue(data.content) ?? '';
      const fingerprint = `${toolCallId}\u0000${content}\u0000${data.is_error === true}`;
      if (state.toolResults.has(fingerprint)) continue;
      state.toolResults.add(fingerprint);
      await emit({
        type: 'user',
        session_id: scope.sessionId,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolCallId,
            content,
            is_error: data.is_error === true,
          }],
        },
      });
    }
  }
}

async function* parseSseData(
  body: AsyncIterable<Uint8Array | string>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    throwIfAborted(signal);
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES * 2) {
      throw new Error('Crush SSE buffer exceeded its safety limit.');
    }
    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = frame.split(/\r?\n/u)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (Buffer.byteLength(data, 'utf8') > MAX_SSE_EVENT_BYTES) {
        throw new Error('Crush SSE event exceeded its safety limit.');
      }
      if (data) yield data;
      boundary = findSseBoundary(buffer);
    }
  }
  buffer += decoder.decode();
  const data = buffer.split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (data) yield data;
}

function findSseBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseCrushEvent(data: string): ParsedCrushEvent | undefined {
  let envelope: JsonRecord;
  try {
    envelope = asRecord(JSON.parse(data)) ?? {};
  } catch {
    throw new Error('Crush emitted malformed SSE JSON.');
  }
  const kind = stringValue(envelope.type);
  if (!kind) return undefined;
  const inner = parseRecord(envelope.payload);
  const eventData = parseRecord(inner.payload);
  return {
    kind,
    envelope,
    inner,
    data: Object.keys(eventData).length > 0 ? eventData : inner,
  };
}

function parseRecord(value: unknown): JsonRecord {
  if (asRecord(value)) return value as JsonRecord;
  if (typeof value !== 'string') return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function eventMatchesScope(event: ParsedCrushEvent, scope: EventScope): boolean {
  const layers = [event.envelope, event.inner, event.data];
  if (hasForeignValue(layers, ['workspace_id', 'workspaceId'], scope.workspaceId)) return false;
  if (hasForeignValue(layers, ['client_id', 'clientId'], scope.clientId)) return false;
  if (hasForeignValue(layers, ['session_id', 'sessionId'], scope.sessionId)) return false;
  if (hasForeignValue(layers, ['run_id', 'runId'], scope.runId)) return false;
  if (event.kind === 'run_complete') {
    const runId = stringValue(event.data.run_id) ?? stringValue(event.data.runId);
    if (runId !== scope.runId) return false;
  }
  return true;
}

function hasForeignValue(
  layers: JsonRecord[],
  keys: string[],
  expected: string,
): boolean {
  for (const layer of layers) {
    for (const key of keys) {
      const value = stringValue(layer[key]);
      if (value != null && value !== expected) return true;
    }
  }
  return false;
}

function asPermissionRequest(value: JsonRecord): CrushPermissionRequest | undefined {
  const id = stringValue(value.id);
  const sessionId = stringValue(value.session_id);
  if (!id || !sessionId) return undefined;
  return {
    ...value,
    id,
    session_id: sessionId,
    tool_call_id: stringValue(value.tool_call_id),
    tool_name: stringValue(value.tool_name),
    action: stringValue(value.action),
    path: stringValue(value.path),
  };
}

function assertPermissionDecision(value: unknown): asserts value is CrushPermissionDecision {
  if (value !== 'allow' && value !== 'allow_session' && value !== 'deny') {
    throw new TypeError('Crush permission handler returned an invalid decision.');
  }
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function jsonRequest<T>(
  httpRequest: CrushHttpRequest,
  options: CrushHttpRequestOptions,
  acceptedStatuses: readonly number[],
): Promise<T> {
  const response = await httpRequest(withJsonHeaders(options));
  assertStatus(response, acceptedStatuses, `${options.method} ${options.path}`);
  const text = await readBody(response.body);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Crush returned invalid JSON for ${options.method} ${options.path}.`);
  }
}

async function emptyRequest(
  httpRequest: CrushHttpRequest,
  options: CrushHttpRequestOptions,
  acceptedStatuses: readonly number[],
): Promise<void> {
  const response = await httpRequest(withJsonHeaders(options));
  assertStatus(response, acceptedStatuses, `${options.method} ${options.path}`);
  await discardBody(response.body);
}

function withJsonHeaders(options: CrushHttpRequestOptions): CrushHttpRequestOptions {
  if (options.body == null) return options;
  return {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(options.body, 'utf8')),
      ...(options.headers ?? {}),
    },
  };
}

function assertStatus(
  response: CrushHttpResponse,
  acceptedStatuses: readonly number[],
  operation: string,
): void {
  if (!acceptedStatuses.includes(response.statusCode)) {
    throw new Error(`Failed to ${operation}: Crush returned HTTP ${response.statusCode}.`);
  }
}

async function readBody(body: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Crush response exceeded its safety limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function discardBody(body: AsyncIterable<Uint8Array | string>): Promise<void> {
  for await (const _chunk of body) {
    // Drain the response so Node can close/reuse the local socket cleanly.
  }
}

function createStderrCollector(secrets: readonly string[]): {
  attach(child: ChildProcess): void;
  value(): string;
} {
  let value = '';
  return {
    attach(child) {
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => {
        if (Buffer.byteLength(value, 'utf8') >= MAX_STDERR_BYTES) return;
        value += String(chunk);
        if (Buffer.byteLength(value, 'utf8') > MAX_STDERR_BYTES) {
          value = Buffer.from(value, 'utf8').subarray(0, MAX_STDERR_BYTES).toString('utf8');
        }
      });
    },
    value() {
      return redactString(value, secrets);
    },
  };
}

function secretValues(
  env: Record<string, string> | undefined,
  additional: readonly string[] = [],
): string[] {
  return [...new Set([
    ...Object.entries(env ?? {})
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && value.length >= 4)
      .map(([, value]) => value),
    ...additional.filter(value => value.length >= 4),
  ])]
    .sort((left, right) => right.length - left.length);
}

function redactEvent(
  event: HadamardBridgeJsonEvent,
  secrets: readonly string[],
): HadamardBridgeJsonEvent {
  return sanitizeValue(event, secrets) as HadamardBridgeJsonEvent;
}

function sanitizeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, secrets));
  const record = asRecord(value);
  if (!record) return value;
  const sanitized: JsonRecord = {};
  for (const [key, child] of Object.entries(record)) {
    sanitized[key] = SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeValue(child, secrets);
  }
  return sanitized;
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
      '$1[REDACTED]',
    );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Crush managed run was aborted.');
  error.name = 'AbortError';
  throw error;
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('Crush managed run was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceWithAbort(new Promise(resolve => {
      timer = setTimeout(resolve, ms);
    }), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bestEffortWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
