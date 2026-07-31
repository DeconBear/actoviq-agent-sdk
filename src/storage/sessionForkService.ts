import type { SessionCreateOptions, StoredSession } from '../types.js';
import { nowIso } from '../runtime/helpers.js';
import type { SessionStore } from './sessionStore.js';
import { MESSAGE_IDS_KEY, SessionGraph } from './sessionGraph.js';

export interface ForkSessionAtMessageOptions {
  title?: string;
  branchName?: string;
  metadata?: Record<string, unknown>;
}

export class SessionForkService {
  private readonly graph: SessionGraph;

  constructor(private readonly store: SessionStore) {
    this.graph = new SessionGraph(store);
  }

  async forkAtMessage(
    sessionId: string,
    messageId: string,
    options: ForkSessionAtMessageOptions = {},
  ): Promise<StoredSession> {
    const source = await this.store.load(sessionId);
    const messages = await this.graph.ensureMessageIds(sessionId);
    const target = messages.find(message => message.id === messageId);
    if (!target) throw new Error(`Unknown message "${messageId}" in Session "${sessionId}".`);
    const metadata = sanitizeForkMetadata({
      ...source.metadata,
      ...(options.metadata ?? {}),
      [MESSAGE_IDS_KEY]: messages.slice(0, target.index + 1).map(message => message.id),
    }, source);
    return this.store.create({
      title: options.title?.trim() || `${source.title} · branch`,
      model: source.model,
      systemPrompt: source.systemPrompt,
      tags: source.tags,
      // A branch of a worktree Session is a normal conversation fork — it must
      // not inherit worktree kind/cwd or it will write into the parent's tree.
      kind: source.kind === 'worktree' ? 'main' : source.kind,
      parentSessionId: source.id,
      parentMessageId: target.id,
      branchName: options.branchName?.trim() || 'Branch',
      originalWorkDir: source.originalWorkDir,
      metadata,
      initialMessages: source.messages.slice(0, target.index + 1),
    });
  }

  async clone(
    sessionId: string,
    options: ForkSessionAtMessageOptions = {},
  ): Promise<StoredSession> {
    const source = await this.store.load(sessionId);
    const messages = await this.graph.ensureMessageIds(sessionId);
    if (messages.length === 0) {
      return this.store.create({
        ...copyCreateOptions(source),
        title: options.title?.trim() || `${source.title} Copy`,
        branchName: options.branchName?.trim() || 'Copy',
        parentSessionId: source.id,
        metadata: sanitizeForkMetadata({ ...source.metadata, ...(options.metadata ?? {}) }, source),
      });
    }
    return this.forkAtMessage(sessionId, messages.at(-1)!.id, {
      ...options,
      title: options.title?.trim() || `${source.title} Copy`,
      branchName: options.branchName?.trim() || 'Copy',
    });
  }

  async label(sessionId: string, branchName: string): Promise<StoredSession> {
    const label = branchName.trim();
    if (!label) throw new Error('Branch label cannot be empty.');
    return this.store.mutate(sessionId, session => ({
      ...session,
      branchName: label,
      updatedAt: nowIso(),
    }));
  }
}

function copyCreateOptions(source: StoredSession): SessionCreateOptions {
  return {
    model: source.model,
    systemPrompt: source.systemPrompt,
    tags: source.tags,
    kind: source.kind === 'worktree' ? 'main' : source.kind,
    originalWorkDir: source.originalWorkDir,
    initialMessages: source.messages,
  };
}

function sanitizeForkMetadata(
  metadata: Record<string, unknown>,
  source: StoredSession,
): Record<string, unknown> {
  const next = { ...metadata };
  for (const key of [
    '__hadamardExecutionId',
    '__hadamardRootExecutionId',
    '__hadamardParentExecutionId',
    '__hadamardParentSessionId',
    '__hadamardAgentPath',
    '__hadamardBackgroundParentRunId',
    '__hadamardBackgroundParentSessionId',
  ]) delete next[key];
  if (source.kind === 'worktree') {
    if (source.originalWorkDir) {
      next.__hadamardWorkDir = source.originalWorkDir;
    } else {
      delete next.__hadamardWorkDir;
    }
  }
  return next;
}
