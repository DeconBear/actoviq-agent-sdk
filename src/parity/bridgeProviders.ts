/**
 * Multi-provider abstraction for the bridge SDK's directCli mode.
 *
 * The vendored-bundle path and the original Claude Code `-p` stream-json path
 * are both the `claude` provider. `pi` and `codex` reuse the same spawn +
 * line-by-line JSONL pipeline but speak their own wire protocols, so each
 * provider supplies four pieces the rest of `hadamardBridgeSdk.ts` stays
 * protocol-agnostic around:
 *
 *   1. executable resolution (which binary on PATH, default error message)
 *   2. argv construction (the provider's CLI flags + prompt placement)
 *   3. child-process env injection (provider-specific credential variables)
 *   4. event normalization (provider JSONL → the `system/assistant/result`
 *      trio `execute()` already switches on — plus claude content-block shape)
 *
 * Normalization is stateful (pi's session id arrives once in a header line;
 * codex's model is never in the stream; assistant text accumulates across
 * deltas), so each provider hands back a fresh normalizer per run.
 */

import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  BridgeProviderDetection,
  RuntimeProviderId,
} from '../types.js';

import { HadamardBridgeProcessError } from '../errors.js';
import { mapHadamardEnvToAnthropicEnv } from '../config/anthropicEnvMapping.js';
import { getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import {
  findExecutableOnPath,
  IS_WINDOWS,
  pathExists,
} from './bridgeExecResolver.js';
import {
  buildCodewhaleArgs,
  createCodewhaleNormalizer,
} from './codewhaleRuntimeAdapter.js';
import { createReasonixAcpSession } from './reasonixAcpSession.js';

const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;
const PROCESS_TREE_KILL_TIMEOUT_MS = 2_500;
const PROCESS_EXIT_OBSERVE_TIMEOUT_MS = 250;
const WINDOWS_PROCESS_TREE_SETTLE_MS = 250;
const WINDOWS_PROCESS_TREE_BATCH_MS = 25;
const pendingWindowsTreeKills: Array<{ pid: number; resolve: () => void }> = [];
let pendingWindowsTreeKillTimer: NodeJS.Timeout | undefined;
let windowsProcessTreeKillTail = Promise.resolve();

function normalizedProbeTimeout(timeoutMs: number | undefined): number {
  return timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_VERSION_PROBE_TIMEOUT_MS;
}

function versionProbeInvocation(executablePath: string): {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} | undefined {
  // A Windows batch shim must run under cmd.exe, and Node cannot guarantee
  // descendant cleanup when taskkill /T is unavailable (for example in a
  // restricted service or sandbox). Version display is best-effort, so do not
  // create a process tree that the runtime may be unable to reclaim.
  if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(executablePath)) return undefined;
  return { file: executablePath, args: ['--version'] };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, PROCESS_EXIT_OBSERVE_TIMEOUT_MS);
    child.once('close', finish);
  });
}

export async function terminateBridgeProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || hasExited(child)) return;

  if (IS_WINDOWS) {
    // Concurrent taskkill /T processes contend inside Windows and can time
    // out while leaving descendants alive. Coalesce probe expirations into a
    // single taskkill invocation; probe deadlines themselves remain parallel.
    await taskkillProcessTree(pid);
  }

  if (!hasExited(child)) child.kill('SIGKILL');
  await waitForChildExit(child);
  // taskkill can report completion while Windows still exposes a just-killed
  // descendant through OpenProcess. Do not resolve provider detection until
  // that terminating state has settled; callers rely on timeout cleanup being
  // complete, not merely requested.
  if (IS_WINDOWS) {
    await new Promise(resolve => setTimeout(resolve, WINDOWS_PROCESS_TREE_SETTLE_MS));
  }
}

function taskkillProcessTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    pendingWindowsTreeKills.push({ pid, resolve });
    if (!pendingWindowsTreeKillTimer) {
      pendingWindowsTreeKillTimer = setTimeout(
        flushWindowsProcessTreeKills,
        WINDOWS_PROCESS_TREE_BATCH_MS,
      );
    }
  });
}

function flushWindowsProcessTreeKills(): void {
  pendingWindowsTreeKillTimer = undefined;
  const batch = pendingWindowsTreeKills.splice(0);
  if (batch.length === 0) return;
  const pids = batch.map(({ pid }) => pid);
  const operation = windowsProcessTreeKillTail.then(() => taskkillProcessTrees(pids));
  windowsProcessTreeKillTail = operation;
  void operation.finally(() => {
    for (const request of batch) request.resolve();
  });
}

function taskkillProcessTrees(pids: readonly number[]): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const taskkillPath = path.join(systemRoot, 'System32', 'taskkill.exe');
  const args = pids.flatMap(pid => ['/pid', String(pid)]);
  args.push('/t', '/f');
  return new Promise(resolve => {
    execFile(
      taskkillPath,
      args,
      {
        shell: false,
        timeout: PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      },
      () => resolve(),
    );
  });
}

function probeExecutableVersion(
  executablePath: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const invocation = versionProbeInvocation(executablePath);
  if (!invocation) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      invocation.file,
      invocation.args,
      {
        encoding: 'utf8',
        maxBuffer: VERSION_PROBE_MAX_BUFFER_BYTES,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error, stdout) => {
        if (timedOut) return;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        const version = stdout.trim();
        resolve(version || undefined);
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateBridgeProcessTree(child).finally(() => {
        reject(new Error('Bridge provider version probe timed out.'));
      });
    }, timeoutMs);
  });
}

/**
 * Per-run state + the translate step. `translate(rawLine)` returns the
 * normalized event to forward, or `null` to drop the line (e.g. a provider
 * status event with no bridge equivalent). Multiple native events may map to
 * a single normalized event; one native event may also emit several.
 */
export interface BridgeEventNormalizer {
  /**
   * Translate one parsed JSON line (stream-json/JSONL providers) into
   * normalized events. Return `[]` to drop the line.
   */
  translate(
    raw: Record<string, unknown>,
    control?: BridgeProcessControl,
  ): HadamardBridgeJsonEvent[];
  /** The provider speaks a bidirectional JSON-lines protocol over stdio. */
  interactive?: true;
  /** Called once after the child process and its stdio pipes are ready. */
  start?(control: BridgeProcessControl): void;
  /** Give an interactive protocol a chance to request graceful cancellation. */
  abort?(control: BridgeProcessControl): void;
  /** Grace period between protocol cancellation and process-tree termination. */
  abortGraceMs?: number;
  /**
   * When true, the provider emits plain text (not JSONL). `translate()` is
   * called with each raw text line as `{_raw: line}`, and `flush()` is
   * called once when stdout ends.
   */
  rawText?: true;
  /** Flush accumulated state at end-of-stream (raw-text providers only). */
  flush?(): HadamardBridgeJsonEvent[];
}

export interface BridgeProcessControl {
  write(record: Record<string, unknown>): void;
  endInput(): void;
}

export interface RuntimeProvider {
  readonly id: RuntimeProviderId;
  /** Binary name looked up on PATH when `executable` is not provided. */
  readonly pathBinary: string;
  /** Human-readable name for "not found on PATH" errors. */
  readonly displayName: string;

  resolveExecutable(explicitPath?: string): Promise<string>;
  /**
   * Best-effort `<binary> --version` probe. Returns the version string on
   * success, or `undefined` if the binary cannot be probed (missing, exits
   * non-zero, hangs, etc.). Used by `detectBridgeProviders()` only — never on
   * the run path. `timeoutMs` is a finite per-process deadline.
   */
  probeVersion(executablePath: string, timeoutMs?: number): Promise<string | undefined>;
  buildArgs(prompt: string, options: HadamardBridgeRunOptions): string[];
  /**
   * Build the child env. `settingsEnv` is the `~/.hadamard/settings.json` env
   * block; `baseEnv` is the inherited process env already filtered to
   * string values. Providers emit whatever credential variables their CLI
   * reads (claude: ANTHROPIC_*, pi/codex: their own).
   */
  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string>;
  /** A fresh normalizer for one run. */
  createNormalizer(
    prompt?: string,
    options?: HadamardBridgeRunOptions,
  ): BridgeEventNormalizer;
  /** Recommended model IDs for this provider (used by TUI `/bridge model`). */
  suggestedModels(): string[];
}

/** Shared base for executable resolution (PATH lookup + explicit-path check). */
export abstract class BaseRuntimeProvider implements RuntimeProvider {
  abstract readonly id: RuntimeProviderId;
  abstract readonly pathBinary: string;
  abstract readonly displayName: string;

  /**
   * Resolve the executable for a run. Precedence (all in-memory; mirrors
   * `buildChildEnvironment` in hadamardBridgeSdk.ts — no file I/O here):
   *   1. `explicitPath` arg (caller-supplied `{ executable }`)
   *   2. `HADAMARD_<ID>_PATH` env var (top-level or `env:` block — both are
   *      captured by `extractEnv` in loadJsonConfigFile.ts)
   *   3. `raw.bridge.providers[id].path` from the loaded settings store
   *   4. `findExecutableOnPath(this.pathBinary)` — the binary on PATH
   *
   * Mirrors the `HADAMARD_BASH_PATH` precedent in src/tools/bash/BashTool.ts.
   */
  async resolveExecutable(explicitPath?: string): Promise<string> {
    // For user-specified paths (explicit, env, settings block), just check
    // existence — the user knows what they're pointing at, and scripts (.mjs,
    // .js, …) often lack +x on Linux. Only PATH lookups need the stricter
    // isExecutable check so we don't pick up non-runnable files.
    if (explicitPath) {
      if (!(await pathExists(explicitPath))) {
        throw new HadamardBridgeProcessError(
          `The configured executable was not found: ${explicitPath}`,
        );
      }
      return explicitPath;
    }

    const envVar = `HADAMARD_${this.id.toUpperCase()}_PATH`;
    const loaded = getLoadedJsonConfig();
    const settingsEnvPath =
      typeof loaded?.env?.[envVar] === 'string' ? loaded.env[envVar] : undefined;
    const processEnvPath = process.env[envVar];
    const envPath = settingsEnvPath ?? processEnvPath;
    if (envPath) {
      if (!(await pathExists(envPath))) {
        throw new HadamardBridgeProcessError(
          `${envVar} (${envPath}) was not found.`,
        );
      }
      return envPath;
    }

    const settingsBlockPath = readSettingsBlockPath(loaded?.raw, this.id);
    if (settingsBlockPath) {
      if (!(await pathExists(settingsBlockPath))) {
        throw new HadamardBridgeProcessError(
          `Configured ${this.id} bridge path (${settingsBlockPath}) was not found.`,
        );
      }
      return settingsBlockPath;
    }

    const pathCandidate = await findExecutableOnPath(this.pathBinary);
    if (pathCandidate) {
      return pathCandidate;
    }
    throw new HadamardBridgeProcessError(
      `No "${this.pathBinary}" executable was found on PATH. Install ${this.displayName}, set ${envVar}, or run \`/bridge\` to configure it.`,
    );
  }

  async probeVersion(
    executablePath: string,
    timeoutMs?: number,
  ): Promise<string | undefined> {
    try {
      return await probeExecutableVersion(
        executablePath,
        normalizedProbeTimeout(timeoutMs),
      );
    } catch {
      return undefined;
    }
  }

  abstract buildArgs(prompt: string, options: HadamardBridgeRunOptions): string[];
  abstract buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string>;
  abstract createNormalizer(): BridgeEventNormalizer;
  abstract suggestedModels(): string[];
}

/**
 * Build a single normalized event with common optional fields pre-stamped.
 * Normalizers route every native event through this so the downstream
 * `execute()` switch (system/assistant/result) and `runtimeInfoFromInitEvent`
 * keep working untouched.
 */
export function bridgeEvent(
  type: string,
  fields: Record<string, unknown> = {},
): HadamardBridgeJsonEvent {
  return { type, ...fields } as HadamardBridgeJsonEvent;
}

let currentProvider: RuntimeProvider | undefined;

/**
 * Read the per-provider path override from the `bridge.providers[id].path`
 * settings block (in-memory only — the caller persists via the settings store).
 */
function readSettingsBlockPath(
  raw: Record<string, unknown> | null | undefined,
  id: RuntimeProviderId,
): string | undefined {
  if (!raw) return undefined;
  const bridge = (raw as { bridge?: unknown }).bridge;
  if (!bridge || typeof bridge !== 'object') return undefined;
  const providers = (bridge as { providers?: unknown }).providers;
  if (!providers || typeof providers !== 'object') return undefined;
  const entry = (providers as Record<string, unknown>)[id];
  if (!entry || typeof entry !== 'object') return undefined;
  const p = (entry as { path?: unknown }).path;
  return typeof p === 'string' && p ? p : undefined;
}

/**
 * The configured default provider, read from `bridge.defaultProvider` in the
 * loaded settings store. Falls back to `'claude'`. Explicit
 * `directCliProvider` (passed to `resolveProvider`) always wins over this.
 */
export function getDefaultProviderId(): RuntimeProviderId {
  const raw = getLoadedJsonConfig()?.raw;
  if (raw && typeof raw === 'object') {
    const bridge = (raw as { bridge?: unknown }).bridge;
    if (bridge && typeof bridge === 'object') {
      const dp = (bridge as { defaultProvider?: unknown }).defaultProvider;
      if (dp === 'claude' || dp === 'pi' || dp === 'codex' || dp === 'codewhale' || dp === 'reasonix' || dp === 'crush') return dp;
    }
  }
  return 'claude';
}

export function resolveProvider(id?: RuntimeProviderId): RuntimeProvider {
  const resolved = id ?? getDefaultProviderId();
  if (resolved === 'claude') return claudeProvider;
  if (resolved === 'pi') return piProvider;
  if (resolved === 'codex') return codexProvider;
  if (resolved === 'codewhale') return codewhaleProvider;
  if (resolved === 'reasonix') return reasonixProvider;
  if (resolved === 'crush') return crushProvider;
  throw new HadamardBridgeProcessError(`Unknown bridge provider: ${String(resolved)}`);
}

/**
 * Probe the locally installed agent CLIs. Resolves each provider via the
 * env/settings/PATH chain (so env overrides are honored) and best-effort
 * `--version`. Probes run concurrently under individual finite deadlines.
 * Never throws — a missing provider is reported as `available: false` with
 * `path: undefined`.
 */
export async function detectBridgeProviders(
  options: { probeTimeoutMs?: number } = {},
): Promise<BridgeProviderDetection[]> {
  const probeTimeoutMs = normalizedProbeTimeout(options.probeTimeoutMs);
  const providers = [
    claudeProvider,
    piProvider,
    codexProvider,
    codewhaleProvider,
    reasonixProvider,
    crushProvider,
  ];
  return Promise.all(providers.map(async provider => {
    let path: string | undefined;
    let available = false;
    let version: string | undefined;
    try {
      path = await provider.resolveExecutable();
      available = Boolean(path);
      if (path) {
        version = await provider.probeVersion(path, probeTimeoutMs);
      }
    } catch {
      // Not installed / not configured — report unavailable.
    }
    return {
      id: provider.id,
      displayName: provider.displayName,
      path,
      available,
      version,
    };
  }));
}

/** Package-private seam for tests that need the ambient provider. */
export function _setCurrentProvider(provider: RuntimeProvider | undefined): void {
  currentProvider = provider;
}
export function _getCurrentProvider(): RuntimeProvider | undefined {
  return currentProvider;
}

// ---------------------------------------------------------------------------
// claude provider (stream-json — the original protocol)
// ---------------------------------------------------------------------------

class ClaudeProvider extends BaseRuntimeProvider {
  readonly id = 'claude' as const;
  readonly pathBinary = 'claude';
  readonly displayName = 'Claude Code (@anthropic-ai/claude-code)';

  buildArgs(prompt: string, _options: HadamardBridgeRunOptions): string[] {
    // The full flag set lives in hadamardBridgeSdk.buildCliArgs(); claude is the
    // default and keeps using that builder. Other providers override buildArgs.
    // (buildCliArgs is invoked directly from hadamardBridgeSdk.ts for the claude
    // path; this indirection exists so the provider list is exhaustive.)
    return ['-p', prompt];
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    // Hadamard settings are the single source of model/credential config: derive
    // ANTHROPIC_* equivalents so the Claude Code-based child process does not
    // silently fall back to ~/.claude/settings.json or keychain credentials.
    // Derived values override inherited process.env ANTHROPIC_* entries, while
    // explicit ANTHROPIC_* keys in the settings env block and caller overrides win.
    return {
      ...baseEnv,
      ...mapHadamardEnvToAnthropicEnv(settingsEnv),
      ...settingsEnv,
      ...(overrides ?? {}),
    };
  }

  createNormalizer(): BridgeEventNormalizer {
    // claude's stream-json is already the canonical system/assistant/result shape.
    return { translate: raw => [raw as HadamardBridgeJsonEvent] };
  }
  suggestedModels(): string[] {
    return ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5'];
  }
}

// ---------------------------------------------------------------------------
// pi provider (pi -p --mode json)
// ---------------------------------------------------------------------------

class PiProvider extends BaseRuntimeProvider {
  readonly id = 'pi' as const;
  readonly pathBinary = 'pi';
  readonly displayName = 'pi CLI (@earendil-works/pi-coding-agent)';

  buildArgs(_prompt: string, options: HadamardBridgeRunOptions): string[] {
    // Pi has no argv option terminator. Managed mode uses the official RPC
    // protocol so arbitrary user text is sent as JSON over stdin, never argv.
    const args = ['--mode', 'rpc'];
    args.push(options.trustProjectResources ? '--approve' : '--no-approve');
    const model = splitPiModel(options.model);
    const provider = model.provider ?? normalizePiProvider(options.credentialProvider);
    if (provider) args.push('--provider', provider);
    if (model.model) args.push('--model', model.model);
    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    } else if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }
    if (options.effort) args.push('--thinking', options.effort);
    args.push(...piToolArguments(options));

    if (typeof options.resume === 'string') {
      args.push('--session', validatePiSessionId(options.resume));
    } else if (options.resume === true) {
      throw new HadamardBridgeProcessError(
        'Pi managed mode requires an exact session id; the interactive --resume picker is unavailable.',
      );
    } else if (options.sessionId) {
      args.push('--session-id', validatePiSessionId(options.sessionId));
    } else if (options.continueMostRecent) {
      args.push('--continue');
    }
    return args;
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    // pi reads *_API_KEY by provider (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
    // We pass the Hadamard settings env through unchanged; callers set the
    // provider-specific key directly. No ANTHROPIC_* remapping for non-claude.
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(prompt = '', options: HadamardBridgeRunOptions = {}): BridgeEventNormalizer {
    return new PiNormalizer(prompt, options);
  }
  suggestedModels(): string[] {
    return ['gpt-5', 'gpt-5-mini', 'claude-sonnet-4-6', 'deepseek-v4-pro', 'gemini-2.5-pro'];
  }
}

const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
const PI_EDIT_TOOLS = [...PI_READ_ONLY_TOOLS, 'edit', 'write'] as const;

function validatePiSessionId(value: string): string {
  const sessionId = value.trim();
  if (
    !sessionId
    || sessionId.length > 256
    || sessionId.startsWith('-')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sessionId)
  ) {
    throw new HadamardBridgeProcessError(
      'Pi session id must contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return sessionId;
}

function splitPiModel(value: string | undefined): { provider?: string; model?: string } {
  const normalized = value?.trim();
  if (!normalized) return {};
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) return { model: normalized };
  return {
    provider: normalized.slice(0, separator),
    model: normalized.slice(separator + 1),
  };
}

function normalizePiProvider(value: string | undefined): string | undefined {
  const provider = value?.trim();
  if (!provider) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider)) {
    throw new HadamardBridgeProcessError(
      'Pi credential provider must contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return provider;
}

function piToolArguments(options: HadamardBridgeRunOptions): string[] {
  if (options.tools === 'none') return ['--no-tools'];

  const bypass = options.dangerouslySkipPermissions
    || options.permissionMode === 'bypassPermissions';
  const permissionUpperBound = bypass
    ? undefined
    : new Set<string>(options.permissionMode === 'acceptEdits'
      ? PI_EDIT_TOOLS
      : PI_READ_ONLY_TOOLS);
  let permitted: string[] | undefined;
  if (Array.isArray(options.tools)) {
    permitted = [...options.tools];
  } else if (!bypass) {
    permitted = options.permissionMode === 'acceptEdits'
      ? [...PI_EDIT_TOOLS]
      : [...PI_READ_ONLY_TOOLS];
  }

  if (options.allowedTools?.length) {
    permitted = permitted
      ? permitted.filter(tool => options.allowedTools!.includes(tool))
      : [...options.allowedTools];
  }
  if (options.disallowedTools?.length && permitted) {
    permitted = permitted.filter(tool => !options.disallowedTools!.includes(tool));
  }
  if (permissionUpperBound && permitted) {
    permitted = permitted.filter(tool => permissionUpperBound.has(tool));
  }

  const args: string[] = [];
  if (permitted) {
    if (permitted.length === 0) return ['--no-tools'];
    args.push('--tools', [...new Set(permitted)].join(','));
  }
  if (options.disallowedTools?.length) {
    args.push('--exclude-tools', [...new Set(options.disallowedTools)].join(','));
  }
  return args;
}

class PiNormalizer implements BridgeEventNormalizer {
  readonly interactive = true as const;
  readonly abortGraceMs = 250;
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private model: string | undefined;
  private initEmitted = false;
  private finalAssistantText = '';
  private streamedAssistantText = '';
  private lastError: string | undefined;
  private stopReason: string | undefined;
  private turns = 0;
  private finished = false;
  private totalCostUsd: number | undefined;

  constructor(
    private readonly prompt: string,
    private readonly options: HadamardBridgeRunOptions,
  ) {}

  start(control: BridgeProcessControl): void {
    control.write({ id: 'hadamard-state', type: 'get_state' });
    control.write({ id: 'hadamard-prompt', type: 'prompt', message: this.prompt });
  }

  abort(control: BridgeProcessControl): void {
    control.write({ id: 'hadamard-abort', type: 'abort' });
  }

  translate(
    raw: Record<string, unknown>,
    control?: BridgeProcessControl,
  ): HadamardBridgeJsonEvent[] {
    const type = typeof raw.type === 'string' ? raw.type : '';

    if (type === 'response' && raw.id === 'hadamard-state') {
      const state = piRpcPayload(raw);
      this.sessionId = stringField(state, 'sessionId', 'session_id', 'id') ?? this.sessionId;
      this.cwd = stringField(state, 'cwd') ?? this.cwd;
      this.model = stringField(state, 'model') ?? this.model;
      return this.emitInit();
    }

    if (type === 'response' && raw.id === 'hadamard-prompt' && raw.success === false) {
      this.lastError = rpcErrorMessage(raw) ?? 'Pi rejected the prompt request.';
      return this.finish(control, true);
    }

    if (type === 'session') {
      this.sessionId = typeof raw.id === 'string' ? raw.id : this.sessionId;
      this.cwd = typeof raw.cwd === 'string' ? raw.cwd : this.cwd;
      return [];
    }

    if (type === 'agent_start') return this.emitInit();

    if (type === 'message_update') {
      const event = raw.assistantMessageEvent;
      if (isRecord(event) && event.type === 'text_delta' && typeof event.delta === 'string') {
        this.streamedAssistantText += event.delta;
        return [bridgeEvent('stream_event', {
          session_id: this.sessionId ?? '',
          event: {
            type: 'content_block_delta',
            index: typeof event.contentIndex === 'number' ? event.contentIndex : 0,
            delta: { type: 'text_delta', text: event.delta },
          },
        })];
      }
      if (isRecord(event) && event.type === 'thinking_delta' && typeof event.delta === 'string') {
        return [bridgeEvent('stream_event', {
          session_id: this.sessionId ?? '',
          event: {
            type: 'content_block_delta',
            index: typeof event.contentIndex === 'number' ? event.contentIndex : 0,
            delta: { type: 'thinking_delta', thinking: event.delta },
          },
        })];
      }
      if (isRecord(event) && event.type === 'error') {
        this.lastError = stringField(event, 'error', 'message') ?? 'Pi assistant stream failed.';
      }
      return [];
    }

    if (type === 'tool_execution_start') {
      return [bridgeEvent('assistant', {
        session_id: this.sessionId ?? '',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: stringField(raw, 'toolCallId', 'tool_call_id') ?? 'pi-tool-unknown',
            name: stringField(raw, 'toolName', 'tool_name') ?? 'tool',
            input: isRecord(raw.args) ? raw.args : {},
          }],
        },
      })];
    }

    if (type === 'tool_execution_update') {
      return [bridgeEvent('stream_event', {
        session_id: this.sessionId ?? '',
        event: {
          type: 'tool_progress',
          tool_call_id: stringField(raw, 'toolCallId', 'tool_call_id'),
          tool_name: stringField(raw, 'toolName', 'tool_name'),
          content: piResultText(raw.partialResult),
          cumulative: true,
        },
      })];
    }

    if (type === 'tool_execution_end') {
      return [bridgeEvent('user', {
        session_id: this.sessionId ?? '',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: stringField(raw, 'toolCallId', 'tool_call_id') ?? 'pi-tool-unknown',
            content: piResultText(raw.result),
            is_error: raw.isError === true,
          }],
        },
      })];
    }

    if (type === 'message_end') {
      const message = raw.message;
      if (isRecord(message) && message.role === 'assistant') {
        this.model = stringField(message, 'model') ?? this.model;
        const text = extractPiAssistantText(message);
        if (text) this.finalAssistantText = text;
        this.stopReason = stringField(message, 'stopReason', 'stop_reason') ?? this.stopReason;
        this.lastError = stringField(message, 'errorMessage', 'error_message') ?? this.lastError;
        const usage = isRecord(message.usage) ? message.usage : undefined;
        const cost = usage && typeof usage.cost === 'number'
          ? usage.cost
          : usage && isRecord(usage.cost) && typeof usage.cost.total === 'number'
            ? usage.cost.total
            : undefined;
        if (cost != null) this.totalCostUsd = (this.totalCostUsd ?? 0) + cost;
        return [bridgeEvent('assistant', {
          session_id: this.sessionId ?? '',
          message: {
            role: 'assistant',
            content: extractPiAssistantContent(message),
            model: this.model,
            usage,
          },
        })];
      }
      return [];
    }

    if (type === 'turn_end') {
      this.turns += 1;
      return [];
    }

    if (type === 'auto_retry_start' || type === 'auto_retry_end'
      || type === 'compaction_start' || type === 'compaction_end'
      || type === 'queue_update' || type === 'extension_error') {
      return [bridgeEvent('system', {
        ...raw,
        subtype: type,
        session_id: this.sessionId ?? '',
      })];
    }

    if (type === 'agent_end' || type === 'agent_settled') {
      return this.finish(control, false);
    }

    return [];
  }

  private emitInit(): HadamardBridgeJsonEvent[] {
    if (this.initEmitted) return [];
    this.initEmitted = true;
    return [bridgeEvent('system', {
      subtype: 'init',
      session_id: this.sessionId ?? (this.options.sessionId ?? ''),
      cwd: this.cwd,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      agents: [],
      skills: [],
      plugins: [],
      model: this.model ?? this.options.model,
      permission_mode: this.options.permissionMode ?? 'default',
    })];
  }

  private finish(
    control: BridgeProcessControl | undefined,
    forcedError: boolean,
  ): HadamardBridgeJsonEvent[] {
    if (this.finished) return [];
    this.finished = true;
    control?.endInput();
    const isError = forcedError || Boolean(this.lastError) || this.stopReason === 'error';
    return [
      ...this.emitInit(),
      bridgeEvent('result', {
        subtype: isError ? 'error' : 'success',
        session_id: this.sessionId ?? (this.options.sessionId ?? ''),
        is_error: isError,
        result: this.lastError || this.finalAssistantText || this.streamedAssistantText,
        stop_reason: isError ? 'error' : (this.stopReason ?? 'end_turn'),
        num_turns: Math.max(1, this.turns),
        total_cost_usd: this.totalCostUsd,
      }),
    ];
  }
}

function piRpcPayload(raw: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(raw.data)) return raw.data;
  if (isRecord(raw.result)) return raw.result;
  return raw;
}

function rpcErrorMessage(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.error === 'string') return raw.error;
  if (isRecord(raw.error)) return stringField(raw.error, 'message', 'error');
  return stringField(raw, 'message');
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  }
  return undefined;
}

function piResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return value == null ? '' : (JSON.stringify(value) ?? '');
  if (Array.isArray(value.content)) {
    return value.content.map(block => {
      if (typeof block === 'string') return block;
      if (isRecord(block) && typeof block.text === 'string') return block.text;
      return isRecord(block) ? (JSON.stringify(block) ?? '') : '';
    }).join('\n');
  }
  return JSON.stringify(value, null, 2) ?? '';
}

function extractPiAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map(block =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? block.text
      : '',
  ).join('');
}

function extractPiAssistantContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(message.content)) {
    const text = typeof message.content === 'string' ? message.content : '';
    return text ? [{ type: 'text', text }] : [];
  }
  const content: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      content.push({ type: 'thinking', thinking: block.thinking });
    }
  }
  return content;
}

// ---------------------------------------------------------------------------
// codex provider (codex exec --json)
// ---------------------------------------------------------------------------

function validateCodexSessionId(value: string): string {
  const sessionId = value.trim();
  if (
    !sessionId
    || sessionId.length > 256
    || sessionId.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(sessionId)
  ) {
    throw new HadamardBridgeProcessError(
      'Codex session id must be a non-option UUID or thread name without control characters.',
    );
  }
  return sessionId;
}

class CodexProvider extends BaseRuntimeProvider {
  readonly id = 'codex' as const;
  readonly pathBinary = 'codex';
  readonly displayName = 'Codex CLI (@openai/codex)';

  buildArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
    const shouldResume = typeof options.resume === 'string'
      || options.resume === true
      || options.continueMostRecent === true;
    const args = shouldResume
      ? ['exec', 'resume', '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check', '--color', 'never'];
    // `codex exec` cannot relay an interactive approval back through this
    // JSONL adapter. Preserve the caller's permission boundary explicitly:
    // default/plan are read-only, acceptEdits is workspace-write, and only an
    // explicit bypassPermissions selection disables the sandbox.
    if (options.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      const sandbox = options.permissionMode === 'acceptEdits'
        ? 'workspace-write'
        : 'read-only';
      args.push(
        '-c', `sandbox_mode="${sandbox}"`,
        '-c', 'approval_policy="never"',
      );
    }
    if (options.model) {
      args.push('-m', options.model);
    }
    if (options.systemPrompt) {
      args.push('-c', `system_prompt="${options.systemPrompt.replace(/"/g, '\\"')}"`);
    }
    if (typeof options.maxTurns === 'number') {
      args.push('-c', `max_turns=${options.maxTurns}`);
    }
    if (shouldResume && typeof options.resume !== 'string') {
      args.push('--last');
    }
    // Codex parses options anywhere before `--`. Keep both the externally
    // supplied prompt and resume identifier in the positional-argument domain
    // so values such as `--dangerously-bypass-approvals-and-sandbox` cannot
    // widen the permission mode selected above.
    args.push('--');
    if (typeof options.resume === 'string') {
      args.push(validateCodexSessionId(options.resume));
    }
    args.push(prompt);
    return args;
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    // codex reads OPENAI_API_KEY / config.toml. Pass Hadamard env through.
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(): BridgeEventNormalizer {
    return new CodexNormalizer();
  }
  suggestedModels(): string[] {
    return ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'];
  }
}

const CODEX_TOOL_ITEM_TYPES = ['command_execution', 'file_change', 'mcp_tool_call'] as const;

function isCodexToolItem(item: Record<string, unknown>): boolean {
  return CODEX_TOOL_ITEM_TYPES.includes(item.type as typeof CODEX_TOOL_ITEM_TYPES[number]);
}

function codexToolName(item: Record<string, unknown>): string {
  if (item.type !== 'mcp_tool_call') return String(item.type);
  const parts = ['mcp'];
  if (typeof item.server === 'string' && item.server) parts.push(item.server);
  if (typeof item.tool === 'string' && item.tool) parts.push(item.tool);
  return parts.length > 1 ? parts.join('__') : 'mcp_tool_call';
}

function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === 'command_execution') {
    return typeof item.command === 'string' ? { command: item.command } : {};
  }
  if (item.type === 'file_change') {
    return { changes: Array.isArray(item.changes) ? item.changes : [] };
  }
  if (isRecord(item.arguments)) return item.arguments;
  return item.arguments === undefined ? {} : { arguments: item.arguments };
}

function codexToolResultContent(item: Record<string, unknown>): string {
  const value = item.type === 'command_execution'
    ? item.aggregated_output ?? item.output ?? item.error
    : item.type === 'file_change'
      ? item.changes ?? item.result ?? item.error
      : item.error ?? item.result;
  if (typeof value === 'string') return value;
  return value == null ? '' : (JSON.stringify(value, null, 2) ?? '');
}

function codexToolResultIsError(item: Record<string, unknown>): boolean {
  return item.status === 'failed'
    || (typeof item.exit_code === 'number' && item.exit_code !== 0)
    || (item.error !== undefined && item.error !== null);
}

class CodexNormalizer implements BridgeEventNormalizer {
  private threadId: string | undefined;
  private initEmitted = false;

  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const type = typeof raw.type === 'string' ? raw.type : '';
    const item = isRecord(raw.item) ? raw.item : undefined;

    if (type === 'thread.started') {
      this.threadId = typeof raw.thread_id === 'string' ? raw.thread_id : this.threadId;
      if (!this.initEmitted) {
        this.initEmitted = true;
        return [bridgeEvent('system', {
          subtype: 'init',
          session_id: this.threadId ?? '',
          // codex exec JSONL carries no model/tools catalog.
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          agents: [],
          skills: [],
          plugins: [],
          model: undefined,
        })];
      }
      return [];
    }

    if ((type === 'item.started' || type === 'item.completed') && item && isCodexToolItem(item)) {
      const id = typeof item.id === 'string' ? item.id : `${String(item.type)}-unknown`;
      if (type === 'item.started') {
        return [bridgeEvent('assistant', {
          session_id: this.threadId ?? '',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id,
              name: codexToolName(item),
              input: codexToolInput(item),
            }],
          },
        })];
      }
      return [bridgeEvent('user', {
        session_id: this.threadId ?? '',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: codexToolResultContent(item),
            is_error: codexToolResultIsError(item),
          }],
        },
      })];
    }

    if (type === 'item.completed') {
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        return [bridgeEvent('assistant', {
          session_id: this.threadId ?? '',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: item.text }],
          },
        })];
      }
      return [];
    }

    if (type === 'turn.completed') {
      return [bridgeEvent('result', {
        subtype: 'success',
        session_id: this.threadId ?? '',
        is_error: false,
        stop_reason: 'end_turn',
        num_turns: 1,
      })];
    }

    if (type === 'turn.failed' || type === 'error') {
      const message = typeof raw.message === 'string'
        ? raw.message
        : (isRecord(raw.error) && typeof raw.error.message === 'string' ? raw.error.message : 'codex run failed');
      return [bridgeEvent('result', {
        subtype: 'error',
        session_id: this.threadId ?? '',
        is_error: true,
        result: message,
        stop_reason: 'error',
        num_turns: 1,
      })];
    }

    return [];
  }
}

// ---------------------------------------------------------------------------
// Plain-text normalizer — shared by providers whose headless mode emits
// plain text (no JSONL / stream-json). Captures the full stdout as the
// assistant text and closes with a result event. No streaming deltas, no
// tool cards — simple and adequate for reasonix / crush.
// ---------------------------------------------------------------------------

class PlainTextNormalizer implements BridgeEventNormalizer {
  rawText = true as const;
  private sessionId: string | undefined;
  private text = '';

  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    // raw-text mode: `parseStdoutEvents` wraps each line as `{_raw: line}`.
    const line = typeof raw._raw === 'string' ? raw._raw : '';
    this.text += (this.text ? '\n' : '') + line;
    return [];
  }

  flush(): HadamardBridgeJsonEvent[] {
    const sid = this.sessionId ?? '';
    return [
      bridgeEvent('system', {
        subtype: 'init',
        session_id: sid,
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        agents: [],
        skills: [],
        plugins: [],
      }),
      bridgeEvent('assistant', {
        session_id: sid,
        message: {
          role: 'assistant',
          content: this.text ? [{ type: 'text', text: this.text }] : [],
        },
      }),
      bridgeEvent('result', {
        subtype: 'success',
        session_id: sid,
        is_error: false,
        result: this.text,
        stop_reason: 'end_turn',
        num_turns: 1,
      }),
    ];
  }
}

// ---------------------------------------------------------------------------
// codewhale provider (stream-json — compatible with Claude Code)
// ---------------------------------------------------------------------------

class CodewhaleProvider extends BaseRuntimeProvider {
  readonly id = 'codewhale' as const;
  readonly pathBinary = 'codewhale';
  readonly displayName = 'CodeWhale CLI (codewhale)';

  buildArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
    return buildCodewhaleArgs(prompt, options);
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(): BridgeEventNormalizer {
    return createCodewhaleNormalizer();
  }
  suggestedModels(): string[] { return []; }
}

// ---------------------------------------------------------------------------
// reasonix provider (plain-text, DeepSeek-native)
// ---------------------------------------------------------------------------

class ReasonixProvider extends BaseRuntimeProvider {
  readonly id = 'reasonix' as const;
  readonly pathBinary = 'reasonix';
  readonly displayName = 'Reasonix CLI (reasonix)';

  buildArgs(_prompt: string, options: HadamardBridgeRunOptions): string[] {
    if (options.resume === true || options.continueMostRecent) {
      throw new HadamardBridgeProcessError(
        'Reasonix managed mode requires an exact persisted session id.',
      );
    }
    const args = ['acp'];
    // --model exists in both the legacy and current ACP CLIs. Effort/budget are
    // negotiated through advertised ACP config options by the session state.
    if (options.model) args.push('--model', validateReasonixValue(options.model, 'model'));
    return args;
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(prompt = '', options: HadamardBridgeRunOptions = {}): BridgeEventNormalizer {
    return new ReasonixAcpNormalizer(prompt, options);
  }
  suggestedModels(): string[] {
    return ['deepseek-v4-pro', 'deepseek-v4-flash'];
  }
}

function validateReasonixValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || normalized.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new HadamardBridgeProcessError(
      `Reasonix ${label} must be a non-option value without control characters.`,
    );
  }
  return normalized;
}

class ReasonixAcpNormalizer implements BridgeEventNormalizer {
  readonly interactive = true as const;
  readonly abortGraceMs = 300;
  private readonly session;

  constructor(prompt: string, options: HadamardBridgeRunOptions) {
    const nativeSessionId = typeof options.resume === 'string'
      ? validateReasonixValue(options.resume, 'session id')
      : undefined;
    this.session = createReasonixAcpSession({
      prompt,
      cwd: options.workDir ?? process.cwd(),
      model: options.model,
      effort: options.effort,
      maxBudgetUsd: options.maxBudgetUsd,
      permissionMode: options.permissionMode ?? 'default',
      nativeSessionId,
    });
  }

  start(control: BridgeProcessControl): void {
    for (const record of this.session.start()) control.write(record);
  }

  abort(control: BridgeProcessControl): void {
    for (const record of this.session.cancel()) control.write(record);
  }

  translate(
    raw: Record<string, unknown>,
    control?: BridgeProcessControl,
  ): HadamardBridgeJsonEvent[] {
    const handled = this.session.handle(raw);
    if (control) {
      for (const record of handled.outbound) control.write(record);
      if (handled.done) control.endInput();
    }
    return handled.events;
  }
}

class CrushProvider extends BaseRuntimeProvider {
  readonly id = 'crush' as const;
  readonly pathBinary = 'crush';
  readonly displayName = 'Crush CLI (crush)';

  buildArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
    const args = ['run'];
    if (options.model) { args.push('-m', options.model); }
    // crush persists sessions per workspace and emits plain text (no session
    // id to capture), so resumed turns use --continue (most-recent). Correct
    // for sequential turns and survives switching away and back.
    if (options.resume || options.continueMostRecent) {
      args.push('--continue');
    }
    args.push(prompt);
    return args;
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(): BridgeEventNormalizer {
    return new PlainTextNormalizer();
  }
  suggestedModels(): string[] {
    return ['gpt-5', 'claude-sonnet-4-6', 'gemini-2.5-pro'];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const claudeProvider: RuntimeProvider = new ClaudeProvider();
export const piProvider: RuntimeProvider = new PiProvider();
export const codexProvider: RuntimeProvider = new CodexProvider();
export const codewhaleProvider: RuntimeProvider = new CodewhaleProvider();
export const reasonixProvider: RuntimeProvider = new ReasonixProvider();
export const crushProvider: RuntimeProvider = new CrushProvider();

export const BRIDGE_PROVIDERS: Record<RuntimeProviderId, RuntimeProvider> = {
  claude: claudeProvider,
  pi: piProvider,
  codex: codexProvider,
  codewhale: codewhaleProvider,
  reasonix: reasonixProvider,
  crush: crushProvider,
};

/**
 * Best-effort credential env-var names each provider's CLI reads. The TUI
 * treats "any one of these set" (across the settings env block ∪ process.env)
 * as "credentials likely configured". Empty arrays mean the provider's
 * credential var is not known from its public surface (codewhale/crush are
 * multi-backend); the UI shows an honest "(unknown)" rather than a wrong key.
 * This is advisory display data only — it never gates a run.
 */
export const BRIDGE_PROVIDER_CREDENTIALS: Record<RuntimeProviderId, string[]> = {
  // claude maps HADAMARD_* → ANTHROPIC_* (see anthropicEnvMapping.ts); either form works.
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'HADAMARD_API_KEY', 'HADAMARD_AUTH_TOKEN'],
  // pi supports OpenAI- and Anthropic-compatible backends.
  pi: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  reasonix: ['DEEPSEEK_API_KEY'],
  codewhale: [],
  crush: [],
};
