export const SANDBOX_POLICY_VERSION = 1;

export type SandboxEnforcement = 'required' | 'best-effort' | 'off';
export type SandboxNetworkMode = 'deny' | 'allowlist' | 'allow';

export interface SandboxNetworkPolicy {
  mode: SandboxNetworkMode;
  allowedDomains: string[];
}

export interface SandboxProcessLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxProcesses?: number;
}

export interface SandboxPolicy {
  version: typeof SANDBOX_POLICY_VERSION;
  enforcement: SandboxEnforcement;
  readRoots: string[];
  writableRoots: string[];
  network: SandboxNetworkPolicy;
  process: SandboxProcessLimits;
  allowUserDisable: boolean;
  source?: string;
}

export interface SandboxCapabilityReport {
  platform: NodeJS.Platform;
  adapter: 'windows-restricted-process' | 'linux-bubblewrap' | 'macos-sandbox-exec' | 'portable-process';
  filesystemIsolation: boolean;
  networkIsolation: boolean;
  processTreeTermination: boolean;
  degraded: boolean;
  reason?: string;
}

export interface SandboxViolation {
  kind: 'filesystem' | 'network' | 'process' | 'unsupported';
  target?: string;
  message: string;
}

export interface SandboxExecutionRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  disableRequested?: boolean;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: NodeJS.Signals;
  capability: SandboxCapabilityReport;
}
