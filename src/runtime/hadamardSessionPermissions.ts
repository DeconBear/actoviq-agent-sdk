import type {
  HadamardPermissionMode,
  HadamardPermissionRule,
  HadamardSessionPermissionState,
} from '../types.js';

export const HADAMARD_SESSION_PERMISSION_STATE_KEY = '__hadamardPermissionState';

const PERMISSION_MODES = new Set<HadamardPermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
]);

export function getPersistedHadamardSessionPermissionState(
  metadata: Record<string, unknown> | undefined,
): HadamardSessionPermissionState {
  const raw = metadata?.[HADAMARD_SESSION_PERMISSION_STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    return { permissions: [] };
  }

  const record = raw as Record<string, unknown>;
  const mode =
    typeof record.mode === 'string' && PERMISSION_MODES.has(record.mode as HadamardPermissionMode)
      ? (record.mode as HadamardPermissionMode)
      : undefined;
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.flatMap((entry): HadamardPermissionRule[] => {
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

export function serializeHadamardSessionPermissionState(
  state: HadamardSessionPermissionState,
): Record<string, unknown> {
  return {
    mode: state.mode,
    permissions: state.permissions.map(rule => ({ ...rule })),
  };
}
