import { execFile } from 'node:child_process';
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
