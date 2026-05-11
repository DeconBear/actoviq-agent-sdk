import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

// ============================================================
// Session Lifecycle Management Example
//
// SessionManager provides lifecycle management for sessions:
// - Idle timeout: automatically marks inactive sessions as idle
// - prune(): removes old/idle/closed sessions
// - closeIdle(): transitions idle → closed
// - stats(): get session counts by status
// - dispose(): clean up all timers
//
// Configure sessionManager when creating the SDK:
//   sessionManager: {
//     idleTimeoutMs: 30 * 60_000,   // 30 min (default)
//     maxSessions: 100,              // max stored sessions
//     cleanupIntervalMs: 5 * 60_000, // auto-cleanup interval
//   }
// ============================================================

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  sessionManager: {
    idleTimeoutMs: 60_000, // 1 minute for demo purposes
    maxSessions: 50,
    cleanupIntervalMs: 10 * 60_000, // 10 min
  },
});

// ---- Create sessions and run something ----
const session1 = await sdk.createSession({ title: 'Research Project' });
await session1.send('Remember that the project code is "Phoenix".');

const session2 = await sdk.createSession({ title: 'Bug Investigation' });
await session2.send('Investigate the login timeout issue.');

// ---- Check session stats ----
let stats = await sdk.sessions.stats();
console.log('Session stats:', stats);
// → { total: 2, active: 2, idle: 0, closed: 0 }

// ---- List all sessions ----
const allSessions = await sdk.sessions.list();
console.log('\nAll sessions:');
for (const s of allSessions) {
  console.log(`  ${s.id} | ${s.status} | ${s.title} | msgs: ${s.messageCount}`);
}

// ---- Manually mark a session as idle (simulates timeout) ----
console.log('\nWaiting for idle timeout... (not needed for demo — we manually close)');

// ---- Prune closed sessions by age ----
const prunedCount = await sdk.sessions.prune({
  status: 'closed',
  olderThan: '7d',
});
console.log('Pruned closed sessions older than 7 days:', prunedCount);

// ---- Close idle sessions ----
const closedCount = await sdk.sessions.closeIdle();
console.log('Closed idle sessions:', closedCount);

// ---- Final stats ----
stats = await sdk.sessions.stats();
console.log('Final stats:', stats);
