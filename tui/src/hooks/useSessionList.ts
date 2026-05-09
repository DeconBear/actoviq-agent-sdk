import { useState, useCallback, useEffect, useRef } from 'react';
import type { ActoviqAgentClient, AgentSession, SessionSummary } from 'actoviq-agent-sdk';

export function useSessionList(client: ActoviqAgentClient | null) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [loading, setLoading] = useState(false);
  const autoCreatedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.sessions.list();
      setSessions(list);
    } finally {
      setLoading(false);
    }
  }, [client]);

  const switchSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      const session = await client.sessions.get(sessionId);
      setActiveSession(session);
    },
    [client],
  );

  const createSession = useCallback(
    async (title?: string) => {
      if (!client) return;
      const session = await client.createSession({ title });
      setActiveSession(session);
      await refresh();
      return session;
    },
    [client, refresh],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      await client.sessions.delete(sessionId);
      if (activeSession?.id === sessionId) {
        setActiveSession(null);
      }
      await refresh();
    },
    [client, activeSession, refresh],
  );

  const renameSession = useCallback(
    async (title: string) => {
      if (!activeSession) return;
      await activeSession.rename(title);
      await refresh();
    },
    [activeSession, refresh],
  );

  // Initial load of session list
  useEffect(() => {
    if (client) refresh();
  }, [client, refresh]);

  // Auto-create a session on mount only if no sessions exist
  useEffect(() => {
    if (!client || autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    client.sessions.list().then((list) => {
      if (list.length === 0) {
        client.createSession({ title: undefined })
          .then((session) => {
            setActiveSession(session);
            refresh();
          })
          .catch(() => {});
      } else {
        // Resume the most recent session
        const mostRecent = list[list.length - 1];
        if (mostRecent) {
          client.sessions.get(mostRecent.id)
            .then((session) => {
              setActiveSession(session);
            })
            .catch(() => {});
        }
      }
    }).catch(() => {});
  }, [client, refresh]);

  return {
    sessions,
    activeSession,
    loading,
    refresh,
    switchSession,
    createSession,
    deleteSession,
    renameSession,
  } as const;
}
