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
  ActoviqSessionMemoryExtractionResult,
  ActoviqToolApprover,
  ActoviqToolClassifier,
  SessionForkOptions,
  StoredSession,
} from '../types.js';
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
  setRuntimePermissionContext: (
    session: AgentSession,
    context: {
      mode?: ActoviqPermissionMode;
      permissions?: ActoviqPermissionRule[];
      classifier?: ActoviqToolClassifier;
      approver?: ActoviqToolApprover;
    },
  ) => void;
  clearRuntimePermissionContext: (session: AgentSession) => void;
  hydrate: (stored: StoredSession) => AgentSession;
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
    return { ...this.stored.metadata };
  }

  get tags(): string[] {
    return [...this.stored.tags];
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

  setPermissionContext(context: {
    mode?: ActoviqPermissionMode;
      permissions?: ActoviqPermissionRule[];
      classifier?: ActoviqToolClassifier;
      approver?: ActoviqToolApprover;
  }): void {
    this.bindings.setRuntimePermissionContext(this, context);
  }

  clearPermissionContext(): void {
    this.bindings.clearRuntimePermissionContext(this);
  }

  async rename(title: string): Promise<void> {
    this.stored.title = title;
    this.stored.titleSource = 'manual';
    this.stored.updatedAt = new Date().toISOString();
    await this.store.save(this.stored);
  }

  async setTags(tags: string[]): Promise<void> {
    this.stored.tags = [...tags];
    this.stored.updatedAt = new Date().toISOString();
    await this.store.save(this.stored);
  }

  async mergeMetadata(metadata: Record<string, unknown>): Promise<void> {
    this.stored.metadata = {
      ...this.stored.metadata,
      ...metadata,
    };
    this.stored.updatedAt = new Date().toISOString();
    await this.store.save(this.stored);
  }

  async delete(): Promise<void> {
    await this.store.delete(this.stored.id);
  }

  async fork(options: SessionForkOptions = {}): Promise<AgentSession> {
    const next = await this.store.fork(this.stored.id, options);
    return this.bindings.hydrate(next);
  }

  replace(next: StoredSession): void {
    this.stored = next;
  }
}

