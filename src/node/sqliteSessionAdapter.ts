import { randomUUID } from 'node:crypto';

import type { InputItem } from '../core/index.js';
import type { RuntimeSessionStore } from '../runtime-v2/state.js';
import type { SessionStoreV2 } from '../storage-v2/index.js';
import { convertLegacyJsonV1Message } from '../storage-v2/legacyJsonV1Items.js';
import { toStorageJson } from './sqliteCheckpointAdapter.js';

export interface SqliteRuntimeSessionAdapterOptions {
  readonly store: SessionStoreV2;
}

/** Canonical-item adapter for the append-only tenant-scoped session store. */
export class SqliteRuntimeSessionAdapter implements RuntimeSessionStore {
  constructor(private readonly options: SqliteRuntimeSessionAdapterOptions) {}

  close(): void {
    // The adapter does not own the shared DurableStorageV2 connection.
  }

  async load(request: {
    readonly tenantId: string;
    readonly sessionId: string;
  }): Promise<{ readonly items: readonly InputItem[]; readonly revision: string }> {
    let session = await this.options.store.get(request);
    if (!session) {
      try {
        session = await this.options.store.create(request);
      } catch (error) {
        // A concurrent creator may win between get/create. Re-read before surfacing it.
        session = await this.options.store.get(request);
        if (!session) throw error;
      }
    }
    const loaded = await this.options.store.load({ ...request, afterSequence: 0 });
    return {
      items: loaded.items.flatMap(item => parseSessionItem(item.kind, item.payload, item.itemId)),
      revision: String(loaded.session.revision),
    };
  }

  async append(request: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly items: readonly InputItem[];
    readonly expectedRevision: string;
  }): Promise<{ readonly revision: string }> {
    const expectedRevision = Number(request.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError(`Invalid session revision "${request.expectedRevision}".`);
    }
    const saved = await this.options.store.append({
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      expectedRevision,
      items: request.items.map(item => ({
        itemId: item.id ?? randomUUID(),
        kind: item.type,
        payload: toStorageJson(item),
      })),
    });
    return { revision: String(saved.revision) };
  }
}

function parseSessionItem(kind: string, value: unknown, itemId: string): InputItem[] {
  // JSON-v1 run records are audit metadata, not conversation messages. Accept
  // both the final name and the name emitted by early storage-v2 previews.
  if (kind === 'legacy_run' || kind === 'run') return [];
  if (kind === 'message' && !isCanonicalItem(value)) {
    return convertLegacyJsonV1Message(value, `session item "${itemId}"`);
  }
  const item = parseCanonicalItem(value, itemId);
  // Provider-specific blocks from an unknown legacy provider cannot safely be
  // replayed to a different provider. They remain in the append journal for
  // audit/export, but are intentionally omitted from the active transcript.
  if (item.type === 'raw' && item.provider === 'legacy') return [];
  return [item];
}

function parseCanonicalItem(value: unknown, itemId: string): InputItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Session item "${itemId}" is not a canonical object.`);
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !CANONICAL_ITEM_TYPES.has(type)) {
    throw new TypeError(`Session item "${itemId}" has unknown canonical type ${String(type)}.`);
  }
  return structuredClone(value) as InputItem;
}

function isCanonicalItem(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string'
    && CANONICAL_ITEM_TYPES.has((value as { type: string }).type);
}

const CANONICAL_ITEM_TYPES = new Set([
  'text',
  'image',
  'audio',
  'document',
  'artifact_ref',
  'tool_call',
  'tool_result',
  'handoff_call',
  'handoff_result',
  'reasoning',
  'raw',
  'structured',
  'refusal',
  'error',
]);
