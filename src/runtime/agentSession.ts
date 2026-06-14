import type { MessageParam } from '../provider/types.js';

import type {
  AgentRunOptions,
  AgentRunResult,
  AgentSessionCompactOptions,
  AgentSessionDreamOptions,
  AgentSessionMemoryExtractionOptions,
  ActoviqAgentContinuityState,
  ActoviqSessionCompactResult,
  ActoviqCompactStateOptions,
  ActoviqCompactState,
  ActoviqDreamRunResult,
  ActoviqDreamState,
  ActoviqHooks,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqSessionPermissionState,
  ActoviqSessionMemoryExtractionResult,
  ActoviqToolApprover,
  ActoviqToolClassifier,
  SessionCheckpoint,
  SessionCheckpointSummary,
  SessionForkOptions,
  StoredSession,
} from '../types.js';
import { getPersistedActoviqSessionPermissionState } from './actoviqSessionPermissions.js';
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
  extractSessionMemory: (
    session: AgentSession,
    options?: AgentSessionMemoryExtractionOptions,
  ) => Promise<ActoviqSessionMemoryExtractionResult>;
  runDream: (
    session: AgentSession,
    options?: AgentSessionDreamOptions,
  ) => Promise<ActoviqDreamRunResult>;
  maybeAutoDream: (
    session: AgentSession,
    options?: AgentSessionDreamOptions,
  ) => Promise<ActoviqDreamRunResult>;
  getDreamState: (session: AgentSession) => Promise<ActoviqDreamState>;
  compactSession: (
    session: AgentSession,
    options?: AgentSessionCompactOptions,
  ) => Promise<ActoviqSessionCompactResult>;
  getCompactState: (
    session: AgentSession,
    options?: Omit<ActoviqCompactStateOptions, 'projectPath' | 'runtimeState' | 'sessionId'>,
  ) => Promise<ActoviqCompactState>;
  getAgentContinuity: (session: AgentSession) => Promise<ActoviqAgentContinuityState>;
  setRuntimeHooks: (session: AgentSession, hooks?: ActoviqHooks) => void;
  clearRuntimeHooks: (session: AgentSession) => void;
  setModel: (session: AgentSession, model: string) => Promise<StoredSession>;
  setRuntimePermissionContext: (
    session: AgentSession,
    context: {
      mode?: ActoviqPermissionMode;
      permissions?: ActoviqPermissionRule[];
      classifier?: ActoviqToolClassifier;
      approver?: ActoviqToolApprover;
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

  get permissionContext(): ActoviqSessionPermissionState {
    return getPersistedActoviqSessionPermissionState(this.stored.metadata);
  }

  snapshot(): StoredSession {
    return deepClone(this.stored);
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

  async extractMemory(
    options: AgentSessionMemoryExtractionOptions = {},
  ): Promise<ActoviqSessionMemoryExtractionResult> {
    return this.bindings.extractSessionMemory(this, options);
  }

  async dream(options: AgentSessionDreamOptions = {}): Promise<ActoviqDreamRunResult> {
    return this.bindings.runDream(this, options);
  }

  async maybeAutoDream(options: AgentSessionDreamOptions = {}): Promise<ActoviqDreamRunResult> {
    return this.bindings.maybeAutoDream(this, options);
  }

  async dreamState(): Promise<ActoviqDreamState> {
    return this.bindings.getDreamState(this);
  }

  async compact(
    options: AgentSessionCompactOptions = {},
  ): Promise<ActoviqSessionCompactResult> {
    return this.bindings.compactSession(this, options);
  }

  async compactState(
    options: Omit<ActoviqCompactStateOptions, 'projectPath' | 'runtimeState' | 'sessionId'> = {},
  ): Promise<ActoviqCompactState> {
    return this.bindings.getCompactState(this, options);
  }

  async agentContinuity(): Promise<ActoviqAgentContinuityState> {
    return this.bindings.getAgentContinuity(this);
  }

  setHooks(hooks?: ActoviqHooks): void {
    this.bindings.setRuntimeHooks(this, hooks);
  }

  clearHooks(): void {
    this.bindings.clearRuntimeHooks(this);
  }

  async setModel(model: string): Promise<void> {
    this.stored = await this.bindings.setModel(this, model);
  }

  async setPermissionContext(context: {
    mode?: ActoviqPermissionMode;
    permissions?: ActoviqPermissionRule[];
    classifier?: ActoviqToolClassifier;
    approver?: ActoviqToolApprover;
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

  async mergeMetadata(metadata: Record<string, unknown>): Promise<void> {
    const updatedAt = new Date().toISOString();
    const updated = {
      ...this.stored,
      metadata: { ...this.stored.metadata, ...metadata },
      updatedAt,
    };
    await this.store.save(updated);
    this.stored = updated;
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

