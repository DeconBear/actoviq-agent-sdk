import { useState, useCallback, useEffect, useRef } from 'react';
import type { ActoviqAgentClient, AgentSession, SessionSummary } from 'actoviq-agent-sdk';

export function useSessionList(client: ActoviqAgentClient | null, initialSession?: string) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [loading, setLoading] = useState(false);
  const autoCreatedRef = useRef(false);
  const prevClientRef = useRef(client);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Reset auto-created flag when client changes so new clients can auto-init
  useEffect(() => {
    if (client !== prevClientRef.current) {
      autoCreatedRef.current = false;
      prevClientRef.current = client;
    }
  }, [client]);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const list = await client.sessions.list();
      if (isMountedRef.current) setSessions(list);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [client]);

  const switchSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      const session = await client.sessions.get(sessionId);
      if (isMountedRef.current) setActiveSession(session);
    },
    [client],
  );

  const createSession = useCallback(
    async (title?: string) => {
      if (!client) return;
      const session = await client.createSession({ title });
      if (isMountedRef.current) {
        setActiveSession(session);
        await refresh();
      }
      return session;
    },
    [client, refresh],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      await client.sessions.delete(sessionId);
      if (isMountedRef.current) {
        if (activeSession?.id === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          if (remaining.length > 0) {
            const mostRecent = remaining[remaining.length - 1]!;
            const session = await client.sessions.get(mostRecent.id);
            if (isMountedRef.current) setActiveSession(session);
          } else {
            setActiveSession(null);
          }
        }
        await refresh();
      }
    },
    [client, activeSession, refresh, sessions],
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

    // If an initial session ID was provided, resume it directly
    if (initialSession) {
      client.sessions.get(initialSession)
        .then((session) => { if (isMountedRef.current) setActiveSession(session); refresh(); })
        .catch(() => {});
      return;
    }

    client.sessions.list().then((list) => {
      if (!isMountedRef.current) return;
      if (list.length === 0) {
        client.createSession({ title: undefined })
          .then((session) => {
            if (isMountedRef.current) {
              setActiveSession(session);
              refresh();
            }
          })
          .catch(() => {});
      } else {
        // Resume the most recent session
        const mostRecent = list[list.length - 1];
        if (mostRecent) {
          client.sessions.get(mostRecent.id)
            .then((session) => {
              if (isMountedRef.current) setActiveSession(session);
            })
            .catch(() => {});
        }
      }
    }).catch(() => {});
  }, [client, refresh, initialSession]);

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
