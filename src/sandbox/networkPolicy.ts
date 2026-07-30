import type { SandboxNetworkPolicy } from './types.js';

export function normalizeNetworkDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^\*\./u, '');
  if (!/^[a-z0-9.-]+$/u.test(domain) || domain.startsWith('.') || domain.endsWith('.')) {
    throw new Error(`Invalid sandbox network domain: ${value}`);
  }
  return domain;
}

export function isNetworkTargetAllowed(
  policy: SandboxNetworkPolicy,
  target: string | URL,
): boolean {
  if (policy.mode === 'allow') return true;
  if (policy.mode === 'deny') return false;
  const host = (target instanceof URL ? target : new URL(target)).hostname.toLowerCase();
  return policy.allowedDomains
    .map(normalizeNetworkDomain)
    .some(domain => host === domain || host.endsWith(`.${domain}`));
}
