import type {
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqSessionPermissionState,
} from '../types.js';

export const ACTOVIQ_SESSION_PERMISSION_STATE_KEY = '__actoviqPermissionState';

const PERMISSION_MODES = new Set<ActoviqPermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
]);

export function getPersistedActoviqSessionPermissionState(
  metadata: Record<string, unknown> | undefined,
): ActoviqSessionPermissionState {
  const raw = metadata?.[ACTOVIQ_SESSION_PERMISSION_STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    return { permissions: [] };
  }

  const record = raw as Record<string, unknown>;
  const mode =
    typeof record.mode === 'string' && PERMISSION_MODES.has(record.mode as ActoviqPermissionMode)
      ? (record.mode as ActoviqPermissionMode)
      : undefined;
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.flatMap((entry): ActoviqPermissionRule[] => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        const rule = entry as Record<string, unknown>;
        if (
          typeof rule.toolName !== 'string' ||
          (rule.behavior !== 'allow' && rule.behavior !== 'deny' && rule.behavior !== 'ask')
        ) {
          return [];
        }
        return [{
          toolName: rule.toolName,
          behavior: rule.behavior,
          matcher: typeof rule.matcher === 'string' ? rule.matcher : undefined,
          source: typeof rule.source === 'string' ? rule.source : undefined,
        }];
      })
    : [];

  return { mode, permissions };
}

export function serializeActoviqSessionPermissionState(
  state: ActoviqSessionPermissionState,
): Record<string, unknown> {
  return {
    mode: state.mode,
    permissions: state.permissions.map(rule => ({ ...rule })),
  };
}
