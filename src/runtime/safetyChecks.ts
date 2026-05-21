import path from 'node:path';

export interface SafetyCheckContext {
  toolName: string;
  publicName: string;
  toolInput: unknown;
  workDir: string;
}

export interface SafetyCheckResult {
  blocked: boolean;
  reason?: string;
}

const PROTECTED_PATHS = [
  '.git',
  '.claude',
  '.actoviq',
];

const PROTECTED_SHELL_FILES = [
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.zshenv',
  '.config/fish/config.fish',
];

export function checkSafety(
  context: SafetyCheckContext,
): SafetyCheckResult {
  const input = context.toolInput as Record<string, unknown> | undefined;

  // Only apply safety checks to destructive tools that touch files
  const filePath = extractFilePath(input);
  if (!filePath) {
    return { blocked: false };
  }

  const normalized = normalizeForSafetyCompare(filePath);

  // Check protected paths
  for (const protectedPath of PROTECTED_PATHS) {
    if (isWithinProtectedPath(normalized, protectedPath)) {
      return {
        blocked: true,
        reason: `Access to ${protectedPath} directories is restricted for safety.`,
      };
    }
  }

  // Check shell config files
  for (const shellFile of PROTECTED_SHELL_FILES) {
    const normalizedShellFile = normalizeForSafetyCompare(shellFile);
    if (
      normalized === normalizedShellFile ||
      normalized.endsWith(`/${normalizedShellFile}`)
    ) {
      return {
        blocked: true,
        reason: `Modifying shell configuration files (${shellFile}) is restricted for safety.`,
      };
    }
  }

  return { blocked: false };
}

function extractFilePath(
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) return undefined;
  const filePath = input.file_path ?? input.filePath ?? input.path;
  if (typeof filePath === 'string' && filePath.length > 0) {
    return filePath;
  }
  return undefined;
}

function isWithinProtectedPath(target: string, protectedDir: string): boolean {
  const normalized = normalizeForSafetyCompare(target);
  const normalizedProtectedDir = normalizeForSafetyCompare(protectedDir);
  const pattern = `/${normalizedProtectedDir}/`;
  const patternStart = `${normalizedProtectedDir}/`;
  const patternEnd = `/${normalizedProtectedDir}`;
  return (
    normalized.includes(pattern) ||
    normalized.startsWith(patternStart) ||
    normalized.endsWith(patternEnd)
  );
}

function normalizeForSafetyCompare(value: string): string {
  return path.normalize(value).replace(/\\/gu, '/').toLowerCase();
}
