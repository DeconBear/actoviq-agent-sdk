import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { linuxSandboxCapabilities } from './linuxSandbox.js';
import { macosSandboxCapabilities } from './macosSandbox.js';
import type {
  SandboxCapabilityReport,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxPolicy,
} from './types.js';
import { windowsSandboxCapabilities } from './windowsSandbox.js';

export class SandboxExecutor {
  readonly capability: SandboxCapabilityReport;

  constructor(readonly policy: SandboxPolicy) {
    this.capability = detectCapabilities(policy);
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    await this.assertCwdAllowed(request.cwd);
    const disabled = request.disableRequested === true
      && this.policy.allowUserDisable
      && this.policy.enforcement !== 'required';
    if (this.policy.enforcement === 'required' && this.capability.degraded) {
      throw new Error(
        `Required sandbox is unavailable: ${this.capability.reason ?? 'platform capability missing'}`,
      );
    }
    const timeoutMs = Math.min(
      request.timeoutMs,
      this.policy.process.timeoutMs ?? request.timeoutMs,
    );
    const maxBuffer = Math.min(
      request.maxBuffer ?? 10 * 1024 * 1024,
      this.policy.process.maxOutputBytes ?? Number.POSITIVE_INFINITY,
    );
    const invocation = disabled || this.policy.enforcement === 'off'
      ? { executable: request.executable, args: request.args }
      : this.wrapInvocation(request);
    return this.spawnAndCollect({
      ...request,
      ...invocation,
      timeoutMs,
      maxBuffer,
    });
  }

  async assertPathAllowed(filePath: string, access: 'read' | 'write'): Promise<string> {
    const target = path.resolve(filePath);
    const roots = access === 'write' ? this.policy.writableRoots : this.policy.readRoots;
    const matched = roots.some(root => isWithin(path.resolve(root), target));
    if (!matched) {
      throw new Error(`Sandbox ${access} path is outside allowed roots: ${target}`);
    }
    const existing = await nearestExistingPath(target);
    const [realTargetParent, realRoots] = await Promise.all([
      realpath(existing).catch(() => existing),
      Promise.all(roots.map(root => realpath(root).catch(() => path.resolve(root)))),
    ]);
    if (!realRoots.some(root => isWithin(root, realTargetParent))) {
      throw new Error(`Sandbox ${access} path resolves outside allowed roots: ${target}`);
    }
    return target;
  }

  private async assertCwdAllowed(cwd: string): Promise<void> {
    await this.assertPathAllowed(cwd, 'read');
  }

  private wrapInvocation(request: SandboxExecutionRequest): {
    executable: string;
    args: string[];
  } {
    if (this.capability.adapter === 'linux-bubblewrap') {
      // Never `--ro-bind / /`: that would ignore readRoots. Start from an empty
      // rootfs, bind a minimal system toolchain, then only the configured roots.
      const args = [
        '--die-with-parent',
        '--new-session',
        '--tmpfs', '/',
        '--proc', '/proc',
        '--dev', '/dev',
      ];
      for (const root of LINUX_SYSTEM_READ_ROOTS) {
        args.push('--ro-bind-try', root, root);
      }
      // PATH / interpreter dirs may be absent on some hosts — bind-try them.
      for (const root of hostToolReadRoots(request)) {
        args.push('--ro-bind-try', root, root);
      }
      const writable = uniqueResolved(this.policy.writableRoots);
      const readable = uniqueResolved([
        ...this.policy.readRoots,
        ...this.policy.writableRoots,
        request.cwd,
        path.dirname(request.executable),
      ]);
      for (const root of readable) {
        if (writable.has(root)) continue;
        args.push('--ro-bind', root, root);
      }
      for (const root of writable) {
        args.push('--bind', root, root);
      }
      if (this.policy.network.mode === 'deny') args.push('--unshare-net');
      args.push('--chdir', request.cwd, '--', request.executable, ...request.args);
      return { executable: 'bwrap', args };
    }
    if (this.capability.adapter === 'macos-sandbox-exec') {
      const profile = macosProfile(this.policy, request);
      return {
        executable: '/usr/bin/sandbox-exec',
        args: ['-p', profile, request.executable, ...request.args],
      };
    }
    return { executable: request.executable, args: request.args };
  }

  private spawnAndCollect(request: SandboxExecutionRequest & {
    maxBuffer: number;
  }): Promise<SandboxExecutionResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      const finish = (
        outcome: { code: number | null; signal: NodeJS.Signals | null } | Error,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        if (outcome instanceof Error) {
          reject(outcome);
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8').trim(),
          stderr: Buffer.concat(stderr).toString('utf8').trim(),
          exitCode: timedOut ? 124 : outcome.code ?? 1,
          ...(outcome.signal ? { signal: outcome.signal } : {}),
          capability: this.capability,
        });
      };
      const capture = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > request.maxBuffer) {
          terminateProcessTree(child.pid);
          finish(new Error(`Sandbox process output exceeded ${request.maxBuffer} bytes.`));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on('data', capture(stdout));
      child.stderr.on('data', capture(stderr));
      child.once('error', finish);
      child.once('exit', (code, signal) => finish({ code, signal }));
      const abort = () => {
        terminateProcessTree(child.pid);
        finish(request.signal?.reason instanceof Error
          ? request.signal.reason
          : new Error('Sandbox process aborted.'));
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid);
      }, request.timeoutMs);
      timer.unref?.();
      if (request.signal?.aborted) abort();
    });
  }
}

function detectCapabilities(policy: SandboxPolicy): SandboxCapabilityReport {
  const base = process.platform === 'win32'
    ? windowsSandboxCapabilities()
    : process.platform === 'linux'
      ? linuxSandboxCapabilities()
      : process.platform === 'darwin'
        ? macosSandboxCapabilities()
        : {
            platform: process.platform,
            adapter: 'portable-process',
            filesystemIsolation: false,
            networkIsolation: false,
            processTreeTermination: true,
            degraded: true,
            reason: `No OS sandbox adapter for ${process.platform}.`,
          } satisfies SandboxCapabilityReport;
  if (policy.network.mode === 'allowlist' && base.networkIsolation) {
    return {
      ...base,
      networkIsolation: false,
      degraded: true,
      reason: 'The platform adapter cannot enforce a hostname allowlist without a configured proxy.',
    };
  }
  return base;
}

/** Minimal host paths required to exec common shells / interpreters inside bwrap. */
const LINUX_SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/group',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
] as const;

/** Host paths sandboxed macOS processes still need to load dyld / system libs. */
const MACOS_SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/private/etc',
  '/private/var/db/dyld',
  '/private/tmp',
  '/tmp',
  '/dev',
  '/etc',
  '/opt/homebrew',
  '/opt/local',
] as const;

/** Temp dirs shells / runtimes may touch even when cwd is elsewhere. */
const MACOS_SYSTEM_WRITE_ROOTS = [
  '/private/tmp',
  '/tmp',
  '/private/var/folders',
  '/var/folders',
] as const;

/**
 * Directories that must stay readable so `bash -lc` / PATH lookups can resolve
 * Node and other host toolchains (e.g. GitHub Actions hostedtoolcache).
 */
function hostToolReadRoots(
  request: SandboxExecutionRequest,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pathDirs = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(entry));
  const home = env.HOME ?? env.USERPROFILE;
  const anchors = [
    path.dirname(request.executable),
    path.dirname(process.execPath),
    // Node distributions often keep ICU / shared files next to `bin/`.
    path.dirname(path.dirname(process.execPath)),
    ...(home ? [path.resolve(home)] : []),
  ];
  return [...new Set([...pathDirs, ...anchors])];
}

function macosProfile(policy: SandboxPolicy, request: SandboxExecutionRequest): string {
  const rules = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach*)',
    '(allow iokit-open)',
    '(allow user-preference-read)',
    '(allow file-read-metadata)',
  ];
  for (const root of MACOS_SYSTEM_READ_ROOTS) {
    rules.push(`(allow file-read* (subpath "${escapeProfile(root)}"))`);
  }
  const readable = uniqueResolved([
    ...policy.readRoots,
    ...policy.writableRoots,
    request.cwd,
    ...hostToolReadRoots(request, request.env ?? process.env),
  ]);
  for (const root of readable) {
    rules.push(`(allow file-read* (subpath "${escapeProfile(root)}"))`);
  }
  for (const root of uniqueResolved([
    ...policy.writableRoots,
    ...MACOS_SYSTEM_WRITE_ROOTS,
  ])) {
    rules.push(`(allow file-write* (subpath "${escapeProfile(root)}"))`);
  }
  if (policy.network.mode === 'allow') rules.push('(allow network*)');
  return rules.join('\n');
}

function uniqueResolved(roots: Iterable<string>): Set<string> {
  return new Set([...roots].map(root => path.resolve(root)));
}

function escapeProfile(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      await realpath(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
}
