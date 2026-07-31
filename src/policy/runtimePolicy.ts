import type {
  HadamardPermissionMode,
  HadamardPermissionRule,
} from '../types.js';
import type { ResolvedPolicy } from './types.js';

export function policyPermissionRules(policy: ResolvedPolicy): HadamardPermissionRule[] {
  return policy.rules.map(rule => ({
    toolName: rule.tool?.trim() || '*',
    behavior: rule.effect,
    ...(rule.pathPattern?.trim()
      ? { matcher: `*${rule.pathPattern.trim()}*` }
      : {}),
    source: `managed-policy:${rule.id}`,
  }));
}

export function policyPermissionMode(
  policy: ResolvedPolicy,
): HadamardPermissionMode | undefined {
  const value = policy.settings.permissionMode;
  return value === 'default'
    || value === 'acceptEdits'
    || value === 'bypassPermissions'
    || value === 'plan'
    || value === 'auto'
    ? value
    : undefined;
}

export function policySetting<T>(
  policy: ResolvedPolicy,
  settingPath: string,
): T | undefined {
  let value: unknown = policy.settings;
  for (const segment of settingPath.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value as T | undefined;
}
