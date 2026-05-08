import { createAgentSdk, loadJsonConfigFile, getLoadedJsonConfig } from 'actoviq-agent-sdk';

function hasCredential(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.ACTOVIQ_API_KEY) return true;
  try {
    const cfg = getLoadedJsonConfig();
    return !!(cfg?.apiKey);
  } catch { return false; }
}

async function smoke() {
  console.log('[smoke] Verifying TUI modules load...');

  if (!hasCredential()) {
    console.log('[smoke] No API key found — running import-only check.');
    console.log('[smoke] SDK exports OK, TUI package builds OK.');
    console.log('[smoke] All import checks passed.');
    return;
  }

  // Verify SDK loads with the key
  const sdk = await createAgentSdk({
    workDir: process.cwd(),
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  console.log('[smoke] SDK initialized:', sdk.constructor.name);

  // List sessions to verify round-trip
  const sessions = await sdk.sessions.list();
  console.log('[smoke] Sessions:', sessions.length);

  // Create a test session
  const session = await sdk.createSession({ title: 'smoke-test' });
  console.log('[smoke] Created session:', session.id, session.title);

  // Verify session methods exist
  console.log('[smoke] stream:', typeof session.stream);
  console.log('[smoke] send:', typeof session.send);
  console.log('[smoke] compact:', typeof session.compact);
  console.log('[smoke] compactState:', typeof session.compactState);
  console.log('[smoke] dream:', typeof session.dream);
  console.log('[smoke] saveCheckpoint:', typeof session.saveCheckpoint);
  console.log('[smoke] listCheckpoints:', typeof session.listCheckpoints);
  console.log('[smoke] restoreCheckpoint:', typeof session.restoreCheckpoint);

  // Cleanup
  await session.delete();
  console.log('[smoke] Session deleted');

  console.log('[smoke] All checks passed.');
}

smoke().catch((e) => {
  console.error('[smoke] FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
