import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { findExecutableOnPath } from '../parity/bridgeExecResolver.js';
import {
  readBridgeConfigs,
  runtimeToProvider,
  type BridgeRuntime,
  type InProcessProvider,
} from '../parity/bridgeConfigs.js';

const execFileAsync = promisify(execFile);

export type AgentRuntimeStatus = 'ready' | 'detected' | 'configured' | 'missing';

export interface AgentRuntimeCandidate {
  id: string;
  label: string;
  runtime: BridgeRuntime;
  commands: string[];
  versionArgs?: string[];
  description: string;
}

export interface DiscoveredAgentRuntime {
  id: string;
  label: string;
  runtime: BridgeRuntime;
  provider: InProcessProvider | null;
  status: AgentRuntimeStatus;
  installed: boolean;
  configured: boolean;
  command?: string;
  commandPath?: string;
  version?: string;
  versionError?: string;
  configNames: string[];
  reuseHint: string;
  description: string;
}

export interface DiscoverAgentRuntimesOptions {
  homeDir?: string;
  candidates?: AgentRuntimeCandidate[];
  resolveCommand?: (command: string) => Promise<string | undefined>;
  readVersion?: (commandPath: string, args: string[]) => Promise<string>;
}

export const DEFAULT_AGENT_RUNTIME_CANDIDATES: AgentRuntimeCandidate[] = [
  {
    id: 'hadamard',
    label: 'Hadamard SDK',
    runtime: 'hadamard',
    commands: [],
    description: 'Built-in Actoviq runtime. No external CLI is required.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    runtime: 'claude',
    commands: ['claude', 'claude-code'],
    versionArgs: ['--version'],
    description: 'Anthropic-compatible local coding agent runtime.',
  },
  {
    id: 'pi-agent',
    label: 'Pi Agent',
    runtime: 'pi',
    commands: ['pi-agent', 'pi'],
    versionArgs: ['--version'],
    description: 'OpenAI-compatible local Pi agent runtime.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    runtime: 'codex',
    commands: ['codex'],
    versionArgs: ['--version'],
    description: 'OpenAI-compatible local Codex agent runtime.',
  },
  {
    id: 'codewhale',
    label: 'CodeWhale',
    runtime: 'codewhale',
    commands: ['codewhale'],
    versionArgs: ['--version'],
    description: 'Anthropic-compatible CodeWhale runtime.',
  },
  {
    id: 'reasonix',
    label: 'Reasonix',
    runtime: 'reasonix',
    commands: ['reasonix'],
    versionArgs: ['--version'],
    description: 'OpenAI-compatible Reasonix runtime.',
  },
  {
    id: 'crush',
    label: 'Crush',
    runtime: 'crush',
    commands: ['crush'],
    versionArgs: ['--version'],
    description: 'OpenAI-compatible Crush runtime.',
  },
];

export async function discoverAgentRuntimes(
  options: DiscoverAgentRuntimesOptions = {},
): Promise<DiscoveredAgentRuntime[]> {
  const candidates = options.candidates ?? DEFAULT_AGENT_RUNTIME_CANDIDATES;
  const configs = readBridgeConfigs(options.homeDir).configs;
  const resolveCommand = options.resolveCommand ?? findExecutableOnPath;
  const readVersion = options.readVersion ?? readRuntimeVersion;
  const results: DiscoveredAgentRuntime[] = [];

  for (const candidate of candidates) {
    const configNames = configs
      .filter((config) => config.runtime === candidate.runtime)
      .map((config) => config.name);
    const configured = candidate.runtime === 'hadamard' || configNames.length > 0;
    let command: string | undefined;
    let commandPath: string | undefined;
    let version: string | undefined;
    let versionError: string | undefined;

    for (const name of candidate.commands) {
      const found = await resolveCommand(name);
      if (found) {
        command = name;
        commandPath = found;
        break;
      }
    }

    const installed = candidate.runtime === 'hadamard' || Boolean(commandPath);
    if (commandPath && candidate.versionArgs) {
      try {
        version = sanitizeVersion(await readVersion(commandPath, candidate.versionArgs));
      } catch (error) {
        versionError = error instanceof Error ? error.message : String(error);
      }
    }

    results.push({
      id: candidate.id,
      label: candidate.label,
      runtime: candidate.runtime,
      provider: runtimeToProvider(candidate.runtime),
      status: runtimeStatus(installed, configured),
      installed,
      configured,
      command,
      commandPath,
      version,
      versionError,
      configNames,
      reuseHint: reuseHint(candidate.runtime, installed, configured, configNames),
      description: candidate.description,
    });
  }

  return results;
}

function runtimeStatus(installed: boolean, configured: boolean): AgentRuntimeStatus {
  if (installed && configured) return 'ready';
  if (installed) return 'detected';
  if (configured) return 'configured';
  return 'missing';
}

function reuseHint(
  runtime: BridgeRuntime,
  installed: boolean,
  configured: boolean,
  configNames: string[],
): string {
  if (runtime === 'hadamard') return 'Built in and always reusable.';
  if (installed && configured) return `Detected locally and configured as ${configNames.join(', ')}.`;
  if (installed) return 'Detected on PATH. Add credentials or a provider config to reuse it from Actoviq.';
  if (configured) return `Configured as ${configNames.join(', ')}, but no local CLI was found on PATH.`;
  return 'Not detected yet. Install the runtime or add a provider config.';
}

async function readRuntimeVersion(commandPath: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(commandPath, args, {
    windowsHide: true,
    timeout: 3000,
    maxBuffer: 64 * 1024,
  });
  return stdout || stderr;
}

function sanitizeVersion(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * A runtime's own local CLI config — the model/provider/credentials the user
 * already configured the CLI with on disk (e.g. `~/.claude/settings.json`).
 * Used by the bridge config editor to offer "reuse the local CLI config" so
 * the user doesn't re-enter what they already set up locally.
 */
export interface RuntimeLocalConfig {
  runtime: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  provider?: InProcessProvider;
  /** Human-readable source path so the UI can show where the values came from. */
  source?: string;
}

/**
 * Read a runtime's local CLI config and extract the model / base URL /
 * API key the user already configured locally. Returns null when the runtime
 * has no detectable local config (unknown runtime, file missing, or no
 * relevant fields populated).
 */
export function detectRuntimeLocalConfig(
  runtime: string,
  homeDir?: string,
): RuntimeLocalConfig | null {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  if (runtime === 'claude' || runtime === 'codewhale' || runtime === 'crush') {
    return detectClaudeStyleLocalConfig(home, runtime);
  }
  if (runtime === 'codex') {
    return detectCodexLocalConfig(home);
  }
  // pi / reasonix / hadamard have no standard local config file to reuse.
  return null;
}

/**
 * Claude Code (and Claude-Code-compatible runtimes like CodeWhale / Crush)
 * store their config in `~/.claude/settings.json` with an `env` block
 * carrying ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL.
 */
function detectClaudeStyleLocalConfig(home: string, runtime: string): RuntimeLocalConfig | null {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return null;
  }
  const env = (raw && typeof raw.env === 'object' ? raw.env : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const model = str(env.ANTHROPIC_MODEL) ?? str(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? str(raw.model);
  const baseURL = str(env.ANTHROPIC_BASE_URL);
  const apiKey = str(env.ANTHROPIC_AUTH_TOKEN) ?? str(env.ANTHROPIC_API_KEY);
  if (!model && !baseURL && !apiKey) return null;
  return {
    runtime,
    model,
    baseURL,
    apiKey,
    provider: 'anthropic',
    source: '~/.claude/settings.json',
  };
}

/**
 * Codex CLI stores its config in `~/.codex/config.toml`. We only extract the
 * `model` (best-effort, single-line) — TOML parsing is intentionally minimal
 * since the file's schema varies across Codex versions.
 */
function detectCodexLocalConfig(home: string): RuntimeLocalConfig | null {
  const configPath = path.join(home, '.codex', 'config.toml');
  if (!existsSync(configPath)) return null;
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  const match = text.match(/^model\s*=\s*"([^"]+)"/m);
  const model = match?.[1]?.trim();
  if (!model) return null;
  return {
    runtime: 'codex',
    model,
    provider: 'openai',
    source: '~/.codex/config.toml',
  };
}
