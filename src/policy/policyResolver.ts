import type { PolicyDocument, PolicyRule, ResolvedPolicy } from './types.js';

const AUTHORITY: Record<PolicyDocument['scope'], number> = {
  host: 4,
  user: 3,
  project: 2,
  session: 1,
};

export function resolvePolicy(documents: PolicyDocument[]): ResolvedPolicy {
  const ordered = [...documents].sort((left, right) => AUTHORITY[right.scope] - AUTHORITY[left.scope]);
  const settings: Record<string, unknown> = {};
  const locked = new Set<string>();
  const rules = new Map<string, PolicyRule>();
  for (const document of ordered) {
    for (const [key, value] of Object.entries(flatten(document.settings))) {
      if (!(key in settings) && !isLocked(locked, key)) settings[key] = value;
    }
    for (const key of document.lockedSettings ?? []) locked.add(key);
    for (const rule of document.rules) {
      if (!rules.has(rule.id)) rules.set(rule.id, { ...rule });
    }
  }
  return {
    settings: unflatten(settings),
    rules: [...rules.values()],
    lockedSettings: [...locked].sort(),
    sources: ordered.map(document => document.scope),
  };
}

function isLocked(locked: Set<string>, candidate: string): boolean {
  return [...locked].some(key => candidate === key || candidate.startsWith(`${key}.`));
}

export function assertPolicyPatchAllowed(
  resolved: ResolvedPolicy,
  patch: Record<string, unknown>,
): void {
  const paths = Object.keys(flatten(patch));
  const blocked = paths.find(candidate =>
    resolved.lockedSettings.some(locked => candidate === locked || candidate.startsWith(`${locked}.`)),
  );
  if (blocked) throw new Error(`Policy setting is locked by a higher authority: ${blocked}`);
}

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.assign(result, flatten(child as Record<string, unknown>, next));
    } else result[next] = child;
  }
  return result;
}

function unflatten(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const parts = key.split('.');
    let cursor = result;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = child;
      else cursor = cursor[part] as Record<string, unknown>
        ?? (cursor[part] = {}) as Record<string, unknown>;
    });
  }
  return result;
}
