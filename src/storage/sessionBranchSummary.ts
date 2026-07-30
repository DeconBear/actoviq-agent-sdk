import { extractPreviewFromMessages } from '../runtime/messageUtils.js';
import type { SessionStore } from './sessionStore.js';

export interface SessionBranchSummary {
  sessionId: string;
  parentSessionId?: string;
  parentMessageId?: string;
  branchName?: string;
  title: string;
  preview: string;
  messageCount: number;
  updatedAt: string;
}

export async function summarizeSessionBranch(
  store: SessionStore,
  sessionId: string,
): Promise<SessionBranchSummary> {
  const session = await store.load(sessionId);
  return {
    sessionId: session.id,
    parentSessionId: session.parentSessionId,
    parentMessageId: session.parentMessageId,
    branchName: session.branchName,
    title: session.title,
    preview: extractPreviewFromMessages(session.messages),
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
  };
}
