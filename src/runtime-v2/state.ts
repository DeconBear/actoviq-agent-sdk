import type {
  InputItem,
  JsonObject,
  OutputItem,
  ToolCallItem,
  Usage,
} from '../core/index.js';
import type { RunEventContext } from '../events/index.js';

export type SerializedRunStatus =
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface SerializedPendingTool {
  readonly call: ToolCallItem;
  readonly effect: 'read' | 'idempotent-write' | 'side-effect';
  readonly status: 'awaiting_approval' | 'prepared' | 'started' | 'committed';
  readonly interruptionId?: string;
  readonly result?: OutputItem;
  readonly idempotencyKey?: string;
}

/** JSON-safe execution checkpoint. It intentionally contains no live clients or secrets. */
export interface SerializedRunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly agentId: string;
  readonly agentConfigDigest: string;
  readonly status: SerializedRunStatus;
  readonly trace: RunEventContext;
  readonly startedAt: string;
  readonly deadlineAt?: string;
  readonly turn: number;
  readonly input: readonly InputItem[];
  readonly transcript: readonly InputItem[];
  readonly generatedItems: readonly OutputItem[];
  readonly usage: Usage;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly expectedSessionRevision?: string;
  readonly workspaceId?: string;
  readonly providerContinuation?: Readonly<JsonObject>;
  readonly pendingTool?: SerializedPendingTool;
  readonly childRunIds: readonly string[];
  readonly contextSerializer?: string;
  readonly serializedContext?: unknown;
  readonly metadata: Readonly<JsonObject>;
}

export type InterruptionDecision =
  | {
      readonly interruptionId: string;
      readonly outcome: 'approve';
      readonly metadata?: Readonly<JsonObject>;
    }
  | {
      readonly interruptionId: string;
      readonly outcome: 'reject';
      readonly reason?: string;
      readonly metadata?: Readonly<JsonObject>;
    };

export interface RunCheckpointStore {
  save(state: SerializedRunState): Promise<void>;
  load(runId: string): Promise<SerializedRunState | undefined>;
  delete(runId: string): Promise<void>;
}

export interface RuntimeSessionStore {
  load(request: {
    readonly tenantId: string;
    readonly sessionId: string;
  }): Promise<{ readonly items: readonly InputItem[]; readonly revision: string }>;
  append(request: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly items: readonly InputItem[];
    readonly expectedRevision: string;
  }): Promise<{ readonly revision: string }>;
  close?(): Promise<void> | void;
}
