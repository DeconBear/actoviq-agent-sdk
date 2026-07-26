import { execFile } from 'node:child_process';

import type { RuntimeProviderId } from '../types.js';
import { resolveExecutableInvocation } from './bridgeExecResolver.js';
import { resolveProvider } from './bridgeProviders.js';

export type ExternalCliAuthRuntime =
  | 'claude'
  | 'codex'
  | 'pi'
  | 'codewhale'
  | 'reasonix'
  | 'crush';
export type ExternalCliAuthState =
  | 'authenticated'
  | 'configured'
  | 'not_authenticated'
  | 'missing'
  | 'unknown';

export interface ExternalCliAuthStatus {
  runtime: ExternalCliAuthRuntime;
  state: ExternalCliAuthState;
  source: 'native-cli';
  method?: string;
  provider?: string;
  message: string;
}

export interface ExternalCliAuthProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ExternalCliAuthProbeOptions {
  executable?: string;
  timeoutMs?: number;
  resolveExecutable?: (runtime: ExternalCliAuthRuntime) => Promise<string>;
  runCommand?: (
    executable: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<ExternalCliAuthProbeResult>;
}

export async function probeExternalCliAuth(
  runtime: ExternalCliAuthRuntime,
  options: ExternalCliAuthProbeOptions = {},
): Promise<ExternalCliAuthStatus> {
  let executable: string;
  try {
    executable = options.executable
      ?? await (options.resolveExecutable ?? defaultResolveExecutable)(runtime);
  } catch {
    return {
      runtime,
      state: 'missing',
      source: 'native-cli',
      message: 'CLI executable was not found.',
    };
  }

  if (runtime === 'reasonix') {
    return {
      runtime,
      state: 'unknown',
      source: 'native-cli',
      method: 'reasonix-setup',
      message: 'Reasonix will reuse its native config and credential store; this version has no non-interactive status command.',
    };
  }

  const args = authStatusArgs(runtime);
  let result: ExternalCliAuthProbeResult;
  try {
    result = await (options.runCommand ?? runAuthCommand)(
      executable,
      args,
      options.timeoutMs ?? 5_000,
    );
  } catch {
    return {
      runtime,
      state: 'unknown',
      source: 'native-cli',
      message: 'The CLI authentication status command failed.',
    };
  }

  switch (runtime) {
    case 'claude': return interpretClaudeStatus(result);
    case 'codex': return interpretCodexStatus(result);
    case 'codewhale': return interpretCodewhaleStatus(result);
    case 'pi': return interpretPiModelCatalog(result);
    case 'crush': return interpretConfiguredProbe(runtime, result, 'Crush native model/provider configuration is available.');
    default: return {
      runtime,
      state: 'unknown',
      source: 'native-cli',
      message: 'The CLI has no recognized authentication status response.',
    };
  }
}

function interpretPiModelCatalog(result: ExternalCliAuthProbeResult): ExternalCliAuthStatus {
  if (result.exitCode === 0 && result.stdout.trim()) {
    return {
      runtime: 'pi',
      state: 'unknown',
      source: 'native-cli',
      method: 'model-catalog',
      message: 'Pi CLI model catalog is available, but this offline probe cannot verify a provider login or API key.',
    };
  }
  return {
    runtime: 'pi',
    state: 'unknown',
    source: 'native-cli',
    method: 'model-catalog',
    message: result.exitCode === 0
      ? 'Pi returned no offline model catalog; provider authentication was not tested.'
      : 'Pi offline model discovery failed; provider authentication was not tested.',
  };
}

function authStatusArgs(runtime: Exclude<ExternalCliAuthRuntime, 'reasonix'>): string[] {
  switch (runtime) {
    case 'claude': return ['auth', 'status'];
    case 'codex': return ['login', 'status'];
    case 'codewhale': return ['auth', 'status'];
    case 'pi': return ['--offline', '--list-models'];
    case 'crush': return ['models'];
  }
}

async function defaultResolveExecutable(runtime: ExternalCliAuthRuntime): Promise<string> {
  return resolveProvider(runtime as RuntimeProviderId).resolveExecutable();
}

function interpretClaudeStatus(result: ExternalCliAuthProbeResult): ExternalCliAuthStatus {
  const parsed = parseLastJsonObject(result.stdout);
  if (parsed && parsed.loggedIn === true) {
    return {
      runtime: 'claude',
      state: 'authenticated',
      source: 'native-cli',
      method: safeLabel(parsed.authMethod),
      provider: safeLabel(parsed.apiProvider),
      message: 'Claude Code reports an active native login.',
    };
  }
  if (parsed && parsed.loggedIn === false) {
    return {
      runtime: 'claude',
      state: 'not_authenticated',
      source: 'native-cli',
      message: 'Claude Code is installed but not logged in.',
    };
  }
  return {
    runtime: 'claude',
    state: result.exitCode === 0 ? 'unknown' : 'not_authenticated',
    source: 'native-cli',
    message: result.exitCode === 0
      ? 'Claude Code did not return a recognized authentication status.'
      : 'Claude Code is installed but native authentication is unavailable.',
  };
}

function interpretCodexStatus(result: ExternalCliAuthProbeResult): ExternalCliAuthStatus {
  const output = (result.stdout + '\n' + result.stderr).toLowerCase();
  if (result.exitCode === 0 && !output.includes('not logged in')) {
    return {
      runtime: 'codex',
      state: 'authenticated',
      source: 'native-cli',
      message: 'Codex reports an active native login.',
    };
  }
  if (output.includes('not logged in') || output.includes('login required')) {
    return {
      runtime: 'codex',
      state: 'not_authenticated',
      source: 'native-cli',
      message: 'Codex is installed but not logged in.',
    };
  }
  return {
    runtime: 'codex',
    state: 'unknown',
    source: 'native-cli',
    message: 'Codex did not return a recognized authentication status.',
  };
}

function interpretCodewhaleStatus(result: ExternalCliAuthProbeResult): ExternalCliAuthStatus {
  const output = `${result.stdout}\n${result.stderr}`;
  const activeMatch = output.match(/active\s+provider\s*:\s*([^\r\n]+)/iu);
  const provider = safeLabel(activeMatch?.[1]);
  const hasConfiguredSource = /\b(config|keyring|env|oauth\s+file)\b/iu.test(output)
    && !/\b(unset|not\s+configured|not\s+logged\s+in)\b/iu.test(output);
  if (result.exitCode === 0 && (provider || hasConfiguredSource)) {
    return {
      runtime: 'codewhale',
      state: 'authenticated',
      source: 'native-cli',
      provider,
      message: 'CodeWhale reports an active native provider configuration.',
    };
  }
  if (/\b(unset|not\s+configured|not\s+logged\s+in)\b/iu.test(output)) {
    return {
      runtime: 'codewhale',
      state: 'not_authenticated',
      source: 'native-cli',
      message: 'CodeWhale is installed but no native provider login is active.',
    };
  }
  return {
    runtime: 'codewhale',
    state: 'unknown',
    source: 'native-cli',
    message: 'CodeWhale did not return a recognized authentication status.',
  };
}

function interpretConfiguredProbe(
  runtime: 'pi' | 'crush',
  result: ExternalCliAuthProbeResult,
  configuredMessage: string,
): ExternalCliAuthStatus {
  if (result.exitCode === 0 && result.stdout.trim()) {
    return {
      runtime,
      state: 'configured',
      source: 'native-cli',
      message: configuredMessage,
    };
  }
  return {
    runtime,
    state: result.exitCode === 0 ? 'unknown' : 'not_authenticated',
    source: 'native-cli',
    message: result.exitCode === 0
      ? `${runtime} returned no configured models.`
      : `${runtime} could not resolve a native model/login configuration.`,
  };
}

function parseLastJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to extraction from mixed warning/status output.
    }
  }

  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) objects.push(text.slice(start, index + 1));
    }
  }
  for (const candidate of objects.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* try the preceding balanced object */ }
  }
  return undefined;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

async function runAuthCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ExternalCliAuthProbeResult> {
  const invocation = await resolveExecutableInvocation(executable, args);
  return new Promise(resolve => {
    execFile(invocation.file, invocation.args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? null : 0,
        stdout,
        stderr,
      });
    });
  });
}
