import type { ChildProcess } from 'node:child_process';

import { IS_WINDOWS } from './bridgeExecResolver.js';
import { terminateBridgeProcessTree } from './bridgeProviders.js';

const POSIX_TERMINATION_GRACE_MS = 250;
const PROCESS_EXIT_WAIT_MS = 1_000;
const activeTerminations = new WeakMap<ChildProcess, Promise<void>>();

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
  });
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // A detached POSIX child should lead its process group. Fall back to the
    // direct process if it exited or group signalling is unavailable.
  }
  if (!hasExited(child)) {
    try {
      child.kill(signal);
    } catch {
      // The process may exit between the state check and signal.
    }
  }
}

async function terminateProcessTreeImpl(child: ChildProcess): Promise<void> {
  if (IS_WINDOWS) {
    await terminateBridgeProcessTree(child);
    return;
  }

  const pid = child.pid;
  if (!pid) return;
  signalProcessGroup(child, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, POSIX_TERMINATION_GRACE_MS));
  if (processGroupIsAlive(pid)) {
    signalProcessGroup(child, 'SIGKILL');
  } else if (!hasExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The direct child exited after the group-liveness check.
    }
  }
  await waitForExit(child, PROCESS_EXIT_WAIT_MS);
}

export function terminateManagedProcessTree(child: ChildProcess): Promise<void> {
  const active = activeTerminations.get(child);
  if (active) return active;
  const termination = terminateProcessTreeImpl(child);
  activeTerminations.set(child, termination);
  return termination;
}
