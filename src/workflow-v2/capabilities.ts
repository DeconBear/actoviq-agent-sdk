import {
  WorkflowCapabilityNotAllowedError,
  WorkflowConfigurationError,
} from './errors.js';
import type {
  WorkflowCapabilityHandler,
  WorkflowCapabilityMap,
} from './types.js';

const CAPABILITY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const RESERVED_CAPABILITY_NAMES = new Set(['constructor', 'prototype', '__proto__']);

export function normalizeCapabilityMap(
  capabilities: WorkflowCapabilityMap | undefined,
): ReadonlyMap<string, WorkflowCapabilityHandler> {
  const normalized = new Map<string, WorkflowCapabilityHandler>();
  for (const [name, handler] of Object.entries(capabilities ?? {})) {
    assertCapabilityName(name);
    if (typeof handler !== 'function') {
      throw new WorkflowConfigurationError(
        `Workflow capability "${name}" must be a function.`,
      );
    }
    normalized.set(name, handler);
  }
  return normalized;
}

export function resolveAllowedCapabilities(
  requested: readonly string[] | undefined,
  configured: ReadonlyMap<string, WorkflowCapabilityHandler>,
): readonly string[] {
  const unique = new Set<string>();
  for (const name of requested ?? []) {
    assertCapabilityName(name);
    if (!configured.has(name)) {
      throw new WorkflowCapabilityNotAllowedError(name);
    }
    unique.add(name);
  }
  return Object.freeze([...unique].sort((left, right) => left.localeCompare(right)));
}

export function assertCapabilityName(name: string): void {
  if (
    !CAPABILITY_NAME_PATTERN.test(name)
    || RESERVED_CAPABILITY_NAMES.has(name)
  ) {
    throw new WorkflowConfigurationError(`Invalid workflow capability name: ${String(name)}.`);
  }
}
