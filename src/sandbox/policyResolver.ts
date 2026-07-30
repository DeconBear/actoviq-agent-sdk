import path from 'node:path';

import type { SandboxEnforcement, SandboxPolicy } from './types.js';

export type SandboxPolicyInput = Partial<Omit<SandboxPolicy, 'version'>> & {
  version?: number;
};

const ENFORCEMENT_RANK: Record<SandboxEnforcement, number> = {
  off: 0,
  'best-effort': 1,
  required: 2,
};

export function defaultSandboxPolicy(workDir: string): SandboxPolicy {
  const root = path.resolve(workDir);
  return {
    version: 1,
    enforcement: 'best-effort',
    readRoots: [root],
    writableRoots: [root],
    network: { mode: 'allow', allowedDomains: [] },
    process: {},
    allowUserDisable: true,
    source: 'default',
  };
}

/**
 * Merge host → user → project → session/options policies.
 *
 * Roots, network, and process limits only tighten. `enforcement: 'off'` is
 * allowed when the current policy still has `allowUserDisable: true` (so an
 * explicit settings/options opt-out works, while a parent that locked
 * `allowUserDisable: false` cannot be weakened). Partial overlays omit
 * `allowUserDisable` without clearing the inherited flag.
 */
export function resolveSandboxPolicy(
  workDir: string,
  ...policies: Array<SandboxPolicyInput | undefined>
): SandboxPolicy {
  let effective = defaultSandboxPolicy(workDir);
  for (const policy of policies) {
    if (!policy) continue;
    const enforcement = resolveEnforcement(
      effective.enforcement,
      policy.enforcement,
      effective.allowUserDisable,
    );
    const readRoots = policy.readRoots
      ? intersectRoots(effective.readRoots, policy.readRoots)
      : effective.readRoots;
    const writableRoots = policy.writableRoots
      ? intersectRoots(effective.writableRoots, policy.writableRoots)
      : effective.writableRoots;
    const network = tightenNetwork(effective.network, policy.network);
    const allowUserDisable = policy.allowUserDisable === undefined
      ? effective.allowUserDisable
      : effective.allowUserDisable && policy.allowUserDisable;
    effective = {
      version: 1,
      enforcement,
      readRoots,
      writableRoots,
      network,
      process: {
        timeoutMs: minimumDefined(effective.process.timeoutMs, policy.process?.timeoutMs),
        maxOutputBytes: minimumDefined(effective.process.maxOutputBytes, policy.process?.maxOutputBytes),
        maxProcesses: minimumDefined(effective.process.maxProcesses, policy.process?.maxProcesses),
      },
      allowUserDisable,
      source: policy.source ?? effective.source,
    };
  }
  return effective;
}

function resolveEnforcement(
  current: SandboxEnforcement,
  next: SandboxEnforcement | undefined,
  allowUserDisable: boolean,
): SandboxEnforcement {
  if (!next) return current;
  if (next === 'off') {
    return allowUserDisable ? 'off' : current;
  }
  return ENFORCEMENT_RANK[next] > ENFORCEMENT_RANK[current] ? next : current;
}

function intersectRoots(current: string[], next: string[]): string[] {
  const normalized = next.map(root => path.resolve(root));
  const result = current.flatMap(root => {
    const resolved = path.resolve(root);
    const children = normalized.filter(candidate => isWithin(resolved, candidate));
    if (children.length > 0) return children;
    return normalized.some(candidate => isWithin(candidate, resolved)) ? [resolved] : [];
  });
  return [...new Set(result)];
}

function tightenNetwork(
  current: SandboxPolicy['network'],
  next: SandboxPolicyInput['network'],
): SandboxPolicy['network'] {
  if (!next) return current;
  if (current.mode === 'deny' || next.mode === 'deny') return { mode: 'deny', allowedDomains: [] };
  if (current.mode === 'allow' && next.mode === 'allow') return { mode: 'allow', allowedDomains: [] };
  const currentDomains = current.mode === 'allowlist' ? current.allowedDomains : next.allowedDomains ?? [];
  const nextDomains = next.mode === 'allowlist' ? next.allowedDomains ?? [] : currentDomains;
  return {
    mode: 'allowlist',
    allowedDomains: currentDomains.filter(domain => nextDomains.includes(domain)).sort(),
  };
}

function minimumDefined(left?: number, right?: number): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
