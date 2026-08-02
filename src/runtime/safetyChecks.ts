import path from 'node:path';

const EXPLICIT_SAFETY_APPROVAL = Symbol('hadamard.explicitSafetyApproval');

export interface SafetyCheckContext {
  toolName: string;
  publicName: string;
  toolInput: unknown;
  workDir: string;
}

export interface SafetyCheckResult {
  blocked: boolean;
  reason?: string;
  requiresExplicitApproval?: boolean;
}

export function markExplicitSafetyApproval<T extends object>(
  context: T,
  approved: boolean,
): T {
  if (approved) {
    Object.defineProperty(context, EXPLICIT_SAFETY_APPROVAL, { value: true });
  }
  return context;
}

export function hasExplicitSafetyApproval(context: object): boolean {
  return (context as { [EXPLICIT_SAFETY_APPROVAL]?: boolean })[EXPLICIT_SAFETY_APPROVAL] === true;
}

const PROTECTED_PATHS = [
  '.git',
  '.claude',
  '.hadamard',
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

  const command = typeof input?.command === 'string' ? input.command : undefined;
  if (command) {
    const catastrophicReason = detectCatastrophicShellCommand(command, context.workDir);
    if (catastrophicReason) {
      return {
        blocked: true,
        reason: catastrophicReason,
        requiresExplicitApproval: true,
      };
    }
  }

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

/**
 * Detect shell commands that can erase a system disk or the active workspace.
 * These commands are never covered by bypass-permissions mode; the permission
 * layer must obtain an explicit approval for the individual invocation.
 */
export function detectCatastrophicShellCommand(
  command: string,
  workDir: string,
): string | null {
  const normalized = command.trim();
  if (!normalized) return null;

  if (
    /\bmkfs(?:\.[a-z0-9]+)?\b[^\r\n]*(?:\/dev\/(?:sd|hd|nvme|vd)[a-z0-9]*|--all)/iu.test(normalized) ||
    /\bdd\b[^\r\n]*\bof\s*=\s*["']?\/dev\/(?:sd|hd|nvme|vd)[a-z0-9]*/iu.test(normalized) ||
    /\b(?:format(?:\.com)?\s+[a-z]:|format-volume\b|clear-disk\b|initialize-disk\b)/iu.test(normalized)
  ) {
    return 'Blocked pending explicit approval: this command can erase or reformat an entire disk.';
  }

  for (const segment of normalized.split(/[;&|\r\n]+/u)) {
    const tokens = tokenizeShellSegment(segment);
    const executableIndex = tokens.findIndex(token => isDeleteExecutable(token));
    if (executableIndex < 0) continue;

    for (const token of tokens.slice(executableIndex + 1)) {
      if (isDeleteOption(token)) continue;
      if (isCatastrophicDeleteTarget(token, workDir)) {
        return 'Blocked pending explicit approval: refusing to recursively delete a system root or the active workspace.';
      }
    }
  }

  return null;
}

function tokenizeShellSegment(segment: string): string[] {
  return [...segment.matchAll(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/gu)]
    .map(match => match[0]!.replace(/^["']|["']$/gu, ''));
}

function isDeleteExecutable(token: string): boolean {
  const name = token.replace(/\\/gu, '/').split('/').at(-1)?.toLowerCase();
  return name === 'rm' || name === 'rmdir' || name === 'rd' ||
    name === 'remove-item' || name === 'del' || name === 'erase' || name === 'ri';
}

function isDeleteOption(token: string): boolean {
  return /^--?[a-z][a-z-]*$/iu.test(token) || /^\/(?:s|q|f)$/iu.test(token);
}

function isCatastrophicDeleteTarget(token: string, workDir: string): boolean {
  const raw = token.trim().replace(/[,)]$/u, '');
  if (!raw) return false;
  if (/^(?:\.|\.\/|\.\\|\.\/\*|\.\\\*|\*|\$PWD|\$\{PWD\}|%CD%)$/iu.test(raw)) {
    return true;
  }
  if (/^(?:\/|\/\*|[a-z]:[\\/]+\*?|%SystemDrive%[\\/]*|\$env:SystemDrive[\\/]*)$/iu.test(raw)) {
    return true;
  }

  const withoutGlob = raw.replace(/[\\/]\*$/u, '');
  const resolvedTarget = path.resolve(workDir, withoutGlob);
  const resolvedWorkDir = path.resolve(workDir);
  const relative = path.relative(resolvedTarget, resolvedWorkDir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
