import type { MiddlewareRef } from '../../core/index.js';
import type { AnyMiddlewareDefinition } from './types.js';

export class MiddlewareRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiddlewareRegistryError';
  }
}

/** Resolves stable AgentSpec middleware references without initializing services. */
export class MiddlewareRegistry {
  private readonly groups = new Map<string, readonly AnyMiddlewareDefinition[]>();

  constructor(
    groups: Readonly<Record<string, AnyMiddlewareDefinition | readonly AnyMiddlewareDefinition[]>> = {},
  ) {
    for (const [id, definitions] of Object.entries(groups)) this.register(id, definitions);
  }

  register(
    id: string,
    definitions: AnyMiddlewareDefinition | readonly AnyMiddlewareDefinition[],
    options: { readonly replace?: boolean } = {},
  ): this {
    const normalized = id.trim();
    if (!normalized) throw new MiddlewareRegistryError('Middleware registry id must not be empty.');
    if (this.groups.has(normalized) && !options.replace) {
      throw new MiddlewareRegistryError(`Middleware "${normalized}" is already registered.`);
    }
    const group = Array.isArray(definitions) ? definitions : [definitions];
    if (group.length === 0) {
      throw new MiddlewareRegistryError(`Middleware "${normalized}" must contain a definition.`);
    }
    this.groups.set(normalized, Object.freeze([...group]));
    return this;
  }

  has(id: string): boolean {
    return this.groups.has(id);
  }

  resolve(refs: readonly MiddlewareRef[] = []): readonly AnyMiddlewareDefinition[] {
    const resolved: AnyMiddlewareDefinition[] = [];
    for (const ref of refs) {
      const id = typeof ref === 'string' ? ref : ref.id;
      const group = this.groups.get(id);
      if (!group) throw new MiddlewareRegistryError(`Unknown middleware reference "${id}".`);
      resolved.push(...group);
    }
    return Object.freeze(resolved);
  }

  list(): readonly string[] {
    return Object.freeze([...this.groups.keys()].sort());
  }
}
