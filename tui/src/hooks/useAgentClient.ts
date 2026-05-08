import { useState, useCallback } from 'react';
import { createAgentSdk, type ActoviqAgentClient } from 'actoviq-agent-sdk';

export function useAgentClient() {
  const [client, setClient] = useState<ActoviqAgentClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);

  const init = useCallback(async () => {
    if (client || initializing) return;
    setInitializing(true);
    setError(null);
    try {
      const sdk = await createAgentSdk({
        workDir: process.cwd(),
      });
      setClient(sdk);
      return sdk;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setInitializing(false);
    }
  }, [client, initializing]);

  const dispose = useCallback(async () => {
    if (client) {
      setClient(null);
    }
  }, [client]);

  return { client, error, initializing, init, dispose } as const;
}
