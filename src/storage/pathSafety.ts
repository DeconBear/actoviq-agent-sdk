import path from 'node:path';

import { ActoviqSdkError } from '../errors.js';

const PATH_SEPARATOR_PATTERN = /[\\/]/u;

export function assertSafeStorageSegment(label: string, value: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    PATH_SEPARATOR_PATTERN.test(value) ||
    path.isAbsolute(value)
  ) {
    throw new ActoviqSdkError(
      `Unsafe ${label} "${value}". Storage keys must be plain path segments.`,
    );
  }
  return value;
}

export function safeStorageFileName(label: string, value: string, extension: string): string {
  const segment = assertSafeStorageSegment(label, value);
  return `${segment}.${extension.replace(/^\./u, '')}`;
}

export function joinUnderStorageRoot(rootDirectory: string, ...segments: string[]): string {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ActoviqSdkError(`Resolved storage path escapes its root: ${target}`);
  }
  return target;
}
