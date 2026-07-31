import { createHash } from 'node:crypto';

import type { MessageParam } from '../provider/types.js';
import type { StoredSession } from '../types.js';
import { deepClone } from '../runtime/helpers.js';
import type { SessionStore } from './sessionStore.js';

const MESSAGE_IDS_KEY = '__hadamardMessageIds';

export interface SessionGraphNode {
  session: StoredSession;
  children: SessionGraphNode[];
}

export interface SessionMessageRef {
  id: string;
  index: number;
  message: MessageParam;
}

export class SessionGraph {
  constructor(private readonly store: SessionStore) {}

  async roots(): Promise<SessionGraphNode[]> {
    const summaries = await this.store.list();
    const sessions = await Promise.all(summaries.map(summary => this.store.load(summary.id)));
    const nodes = new Map<string, SessionGraphNode>(
      sessions.map(session => [
        session.id,
        { session, children: [] },
      ]),
    );
    const roots: SessionGraphNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.session.parentSessionId
        ? nodes.get(node.session.parentSessionId)
        : undefined;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    const sort = (items: SessionGraphNode[]) => {
      items.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
      items.forEach(item => sort(item.children));
    };
    sort(roots);
    return roots;
  }

  messages(session: StoredSession): SessionMessageRef[] {
    const configured = session.metadata[MESSAGE_IDS_KEY];
    const ids = Array.isArray(configured)
      ? configured.filter((value): value is string => typeof value === 'string')
      : [];
    return session.messages.map((message, index) => ({
      id: ids[index] ?? legacyMessageId(session.id, index, message),
      index,
      message: deepClone(message),
    }));
  }

  async ensureMessageIds(sessionId: string): Promise<SessionMessageRef[]> {
    const updated = await this.store.mutate(sessionId, session => {
      const current = this.messages(session);
      return {
        ...session,
        metadata: {
          ...session.metadata,
          [MESSAGE_IDS_KEY]: current.map(message => message.id),
        },
      };
    });
    return this.messages(updated);
  }
}

function legacyMessageId(sessionId: string, index: number, message: MessageParam): string {
  return `msg_${createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(String(index))
    .update('\0')
    .update(JSON.stringify(message))
    .digest('hex')
    .slice(0, 20)}`;
}

export { MESSAGE_IDS_KEY };
