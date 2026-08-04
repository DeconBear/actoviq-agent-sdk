import type { MessageParam } from '../provider/types.js';

import type {
  AgentRunOptions,
  AgentRunResult,
  AgentSessionCompactOptions,
  AgentSessionDreamOptions,
  HadamardAgentContinuityState,
  HadamardSessionCompactResult,
  HadamardCompactStateOptions,
  HadamardCompactState,
  HadamardDreamRunResult,
  HadamardDreamState,
  HadamardHooks,
  HadamardPermissionMode,
  HadamardPermissionRule,
  HadamardSessionPermissionState,
  HadamardToolApprover,
  HadamardToolClassifier,
  SessionCheckpoint,
  SessionCheckpointSummary,
  SessionForkOptions,
  StoredSession,
} from '../types.js';
import { getPersistedHadamardSessionPermissionState } from './hadamardSessionPermissions.js';
import type { SessionStore } from '../storage/sessionStore.js';
import { AgentRunStream } from './asyncQueue.js';
import { deepClone } from './helpers.js';

interface AgentSessionBindings {
  runSession: (
    session: AgentSession,
    input: string | MessageParam['content'],
    options?: AgentRunOptions,
  ) => Promise<AgentRunResult>;
  streamSession: (
    session: AgentSession,
    input: string | MessageParam['content'],
    options?: AgentRunOptions,
  ) => AgentRunStream;
  runSkillOnSession: (
    session: AgentSession,
    skill: string,
    args?: string,
    options?: AgentRunOptions,
  ) => Promise<AgentRunResult>;
  streamSkillOnSession: (
    session: AgentSession,
    skill: string,
    args?: string,
    options?: AgentRunOptions,
  ) => AgentRunStream;
  runDream: (
    session: AgentSession,
    options?: AgentSessionDreamOptions,
  ) => Promise<HadamardDreamRunResult>;
  maybeAutoDream: (
    session: AgentSession,
    options?: AgentSessionDreamOptions,
  ) => Promise<HadamardDreamRunResult>;
  getDreamState: (session: AgentSession) => Promise<HadamardDreamState>;
  compactSession: (
    session: AgentSession,
    options?: AgentSessionCompactOptions,
  ) => Promise<HadamardSessionCompactResult>;
  getCompactState: (
    session: AgentSession,
    options?: Omit<HadamardCompactStateOptions, 'projectPath' | 'runtimeState' | 'sessionId'>,
  ) => Promise<HadamardCompactState>;
  getAgentContinuity: (session: AgentSession) => Promise<HadamardAgentContinuityState>;
  setRuntimeHooks: (session: AgentSession, hooks?: HadamardHooks) => void;
  clearRuntimeHooks: (session: AgentSession) => void;
  setModel: (session: AgentSession, model: string) => Promise<StoredSession>;
  setRuntimePermissionContext: (
    session: AgentSession,
    context: {
      mode?: HadamardPermissionMode;
      permissions?: HadamardPermissionRule[];
      classifier?: HadamardToolClassifier;
      approver?: HadamardToolApprover;
    },
  ) => Promise<StoredSession>;
  clearRuntimePermissionContext: (session: AgentSession) => Promise<StoredSession>;
  hydrate: (stored: StoredSession) => AgentSession;
  saveCheckpoint: (session: AgentSession, label: string) => Promise<SessionCheckpoint>;
  restoreCheckpoint: (session: AgentSession, checkpointId: string) => Promise<void>;
  listCheckpoints: (session: AgentSession) => Promise<SessionCheckpointSummary[]>;
  deleteCheckpoint: (session: AgentSession, checkpointId: string) => Promise<void>;
}

export class AgentSession {
  private readonly steeringInputs: string[] = [];
  private readonly followUpInputs: string[] = [];

  constructor(
    private readonly bindings: AgentSessionBindings,
    private readonly store: SessionStore,
    private stored: StoredSession,
  ) {}

  get id(): string {
    return this.stored.id;
  }

  get title(): string {
    return this.stored.title;
  }

  get model(): string {
    return this.stored.model;
  }

  get messages(): MessageParam[] {
    return deepClone(this.stored.messages);
  }

  get metadata(): Record<string, unknown> {
    return deepClone(this.stored.metadata);
  }

  get tags(): string[] {
    return [...this.stored.tags];
  }

  get permissionContext(): HadamardSessionPermissionState {
    return getPersistedHadamardSessionPermissionState(this.stored.metadata);
  }

  get pendingInputCount(): number {
    return this.steeringInputs.length + this.followUpInputs.length;
  }

  snapshot(): StoredSession {
    return deepClone(this.stored);
  }

  /**
   * Queue guidance for the next model sample in the active run. If the model
   * is currently streaming its final response, the engine continues the run
   * once that response reaches a natural stopping point.
   */
  steer(input: string): void {
    const normalized = input.trim();
    if (!normalized) {
      throw new Error('Steering input cannot be empty.');
    }
    this.steeringInputs.push(normalized);
  }

  /**
   * Queue a follow-up that runs after the current response completes. This is
   * distinct from steering, which may be injected immediately after tools.
   */
  followUp(input: string): void {
    const normalized = input.trim();
    if (!normalized) {
      throw new Error('Follow-up input cannot be empty.');
    }
    this.followUpInputs.push(normalized);
  }

  /** @internal Runtime bridge for the conversation engine. */
  drainSteeringInputs(): string[] {
    return this.steeringInputs.splice(0);
  }

  /** @internal Runtime bridge for the conversation engine. */
  drainFollowUpInputs(): string[] {
    return this.followUpInputs.splice(0);
  }

  async send(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.bindings.runSession(this, input, options);
  }

  stream(
    input: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): AgentRunStream {
    return this.bindings.streamSession(this, input, options);
  }

  runSkill(
    skill: string,
    args = '',
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.bindings.runSkillOnSession(this, skill, args, options);
  }

  streamSkill(
    skill: string,
    args = '',
    options: AgentRunOptions = {},
  ): AgentRunStream {
    return this.bindings.streamSkillOnSession(this, skill, args, options);
  }

  async dream(options: AgentSessionDreamOptions = {}): Promise<HadamardDreamRunResult> {
    return this.bindings.runDream(this, options);
  }

  async maybeAutoDream(options: AgentSessionDreamOptions = {}): Promise<HadamardDreamRunResult> {
    return this.bindings.maybeAutoDream(this, options);
  }

  async dreamState(): Promise<HadamardDreamState> {
    return this.bindings.getDreamState(this);
  }

  async compact(
    options: AgentSessionCompactOptions = {},
  ): Promise<HadamardSessionCompactResult> {
    return this.bindings.compactSession(this, options);
  }

  async compactState(
    options: Omit<HadamardCompactStateOptions, 'projectPath' | 'runtimeState' | 'sessionId'> = {},
  ): Promise<HadamardCompactState> {
    return this.bindings.getCompactState(this, options);
  }

  async agentContinuity(): Promise<HadamardAgentContinuityState> {
    return this.bindings.getAgentContinuity(this);
  }

  setHooks(hooks?: HadamardHooks): void {
    this.bindings.setRuntimeHooks(this, hooks);
  }

  clearHooks(): void {
    this.bindings.clearRuntimeHooks(this);
  }

  async setModel(model: string): Promise<void> {
    this.stored = await this.bindings.setModel(this, model);
  }

  async setPermissionContext(context: {
    mode?: HadamardPermissionMode;
    permissions?: HadamardPermissionRule[];
    classifier?: HadamardToolClassifier;
    approver?: HadamardToolApprover;
  }): Promise<void> {
    this.stored = await this.bindings.setRuntimePermissionContext(this, context);
  }

  async clearPermissionContext(): Promise<void> {
    this.stored = await this.bindings.clearRuntimePermissionContext(this);
  }

  async rename(title: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    const updated = { ...this.stored, title, titleSource: 'manual' as const, updatedAt };
    await this.store.save(updated);
    this.stored = updated;
  }

  async setTags(tags: string[]): Promise<void> {
    const updatedAt = new Date().toISOString();
    const updated = { ...this.stored, tags: [...tags], updatedAt };
    await this.store.save(updated);
    this.stored = updated;
  }

  /**
   * Append messages to the stored transcript without starting a new run.
   * Used by the GUI bridge-run path to persist bridge turns into the
   * hadamard chat transcript so they survive reload.
   */
  async appendMessages(messages: MessageParam[]): Promise<void> {
    const updatedAt = new Date().toISOString();
    const updated = {
      ...this.stored,
      messages: [...this.stored.messages, ...messages],
      updatedAt,
    };
    await this.store.save(updated);
    this.stored = updated;
  }

  async mergeMetadata(metadata: Record<string, unknown>): Promise<void> {
    await this.mutateMetadata(current => ({ ...current, ...metadata }));
  }

  /**
   * Atomically update Session metadata through SessionStore.mutate.
   *
   * This avoids a stale live AgentSession overwriting metadata written by a
   * concurrent catalog/action/runtime path between snapshot and save.
   */
  async mutateMetadata(
    mutation: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const updatedAt = new Date().toISOString();
    const updated = await this.store.mutate(this.stored.id, current => ({
      ...current,
      metadata: mutation({ ...current.metadata }),
      updatedAt,
    }));
    this.stored = updated;
    return { ...updated.metadata };
  }

  async delete(): Promise<void> {
    await this.store.delete(this.stored.id);
  }

  async fork(options: SessionForkOptions = {}): Promise<AgentSession> {
    const next = await this.store.fork(this.stored.id, options);
    return this.bindings.hydrate(next);
  }

  async saveCheckpoint(label: string): Promise<SessionCheckpoint> {
    return this.bindings.saveCheckpoint(this, label);
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    return this.bindings.restoreCheckpoint(this, checkpointId);
  }

  listCheckpoints(): Promise<SessionCheckpointSummary[]> {
    return this.bindings.listCheckpoints(this);
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    return this.bindings.deleteCheckpoint(this, checkpointId);
  }

  replace(next: StoredSession): void {
    this.stored = next;
  }
}

