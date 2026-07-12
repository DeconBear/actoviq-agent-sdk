export type RuntimeServiceId =
  | 'sessions'
  | 'checkpoints'
  | 'memory'
  | 'artifacts'
  | 'tools'
  | 'tracing'
  | (string & {});

export interface RuntimeService {
  close?(): Promise<void> | void;
}

export type RuntimeServiceFactory<T extends RuntimeService = RuntimeService> =
  () => Promise<T> | T;

export interface RuntimeServiceDefinition<T extends RuntimeService = RuntimeService> {
  factory: RuntimeServiceFactory<T>;
  /** Included in diagnostics without initializing the service. */
  description?: string;
}

interface RuntimeServiceSlot {
  definition: RuntimeServiceDefinition;
  instance?: RuntimeService;
  pending?: Promise<RuntimeService>;
}

/**
 * Explicit, lazy runtime service container. Construction performs no I/O;
 * factories run only when the owning profile/middleware resolves a service.
 */
export class RuntimeServices {
  private readonly slots = new Map<RuntimeServiceId, RuntimeServiceSlot>();
  private readonly initializationOrder: RuntimeServiceId[] = [];
  private closed = false;

  constructor(
    definitions: Readonly<Record<string, RuntimeServiceDefinition>> = {},
  ) {
    for (const [id, definition] of Object.entries(definitions)) {
      this.register(id, definition);
    }
  }

  register<T extends RuntimeService>(
    id: RuntimeServiceId,
    definition: RuntimeServiceDefinition<T>,
  ): void {
    this.assertOpen();
    if (!id.trim()) {
      throw new Error('Runtime service id must not be empty.');
    }
    if (this.slots.has(id)) {
      throw new Error(`Runtime service "${id}" is already registered.`);
    }
    this.slots.set(id, { definition: definition as RuntimeServiceDefinition });
  }

  has(id: RuntimeServiceId): boolean {
    return this.slots.has(id);
  }

  isInitialized(id: RuntimeServiceId): boolean {
    return this.slots.get(id)?.instance != null;
  }

  inspect(): Array<{
    id: RuntimeServiceId;
    initialized: boolean;
    pending: boolean;
    description?: string;
  }> {
    return [...this.slots.entries()].map(([id, slot]) => ({
      id,
      initialized: slot.instance != null,
      pending: slot.pending != null,
      description: slot.definition.description,
    }));
  }

  async resolve<T extends RuntimeService>(id: RuntimeServiceId): Promise<T> {
    this.assertOpen();
    const slot = this.slots.get(id);
    if (!slot) {
      throw new Error(`Runtime service "${id}" is not registered.`);
    }
    if (slot.instance) {
      return slot.instance as T;
    }
    if (slot.pending) {
      return slot.pending as Promise<T>;
    }

    const pending = Promise.resolve().then(() => slot.definition.factory());
    slot.pending = pending;
    try {
      const instance = await pending;
      if (this.closed) {
        await instance.close?.();
        throw new Error('Runtime services were closed during initialization.');
      }
      slot.instance = instance;
      this.initializationOrder.push(id);
      return instance as T;
    } finally {
      slot.pending = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    for (const id of [...this.initializationOrder].reverse()) {
      const instance = this.slots.get(id)?.instance;
      if (!instance?.close) continue;
      try {
        await instance.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more runtime services failed to close.');
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Runtime services are closed.');
    }
  }
}
