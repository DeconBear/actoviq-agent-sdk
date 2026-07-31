/**
 * scheduling.ts — Cron-based task scheduling
 *
 * Demonstrates:
 *   - Creating a TaskScheduler
 *   - Registering tasks with different cron expressions
 *   - Manual trigger bypassing cron schedule
 *   - Listing, inspecting, and removing tasks
 *   - Custom persistence store
 */

import { TaskScheduler, InMemoryTaskStore, nextCronTime, msUntilNextCron, createAgentSdk } from '../src/index.js';

// ─── 1. Quick cron preview ───────────────────────────────────

const nextDaily = nextCronTime('0 9 * * 1-5');
console.log(`Next weekday 9am: ${nextDaily.toISOString()}`);
console.log(`Ms until next minute mark: ${msUntilNextCron('* * * * *').toFixed(0)}ms\n`);

// ─── 2. Create scheduler ─────────────────────────────────────

const scheduler = new TaskScheduler({
  defaultTimeoutMs: 30_000,
  defaultMaxRetries: 2,
});

// ─── 3. Register tasks ───────────────────────────────────────

await scheduler.schedule({
  id: 'heartbeat',
  schedule: { cron: '*/5 * * * *' }, // Every 5 minutes
  description: 'Log a heartbeat',
  task: async (ctx) => {
    console.log(`[${new Date().toISOString()}] Heartbeat #${ctx.invocationCount}`);
  },
});

await scheduler.schedule({
  id: 'daily-summary',
  schedule: { cron: '30 9 * * *' }, // Every day at 9:30 AM
  description: 'Generate daily summary',
  maxRetries: 3,
  retryDelayMs: 2000,
  task: async (ctx) => {
    console.log(`Generating daily summary (attempt ${ctx.invocationCount})...`);
    // In real usage: call sdk.runAgent(...) or send a webhook
  },
});

await scheduler.schedule({
  id: 'cleanup',
  schedule: { cron: '0 */6 * * *' }, // Every 6 hours
  description: 'Clean up stale sessions',
  task: async () => {
    console.log('Running cleanup...');
  },
});

console.log('Registered 3 tasks:\n');

// ─── 4. Inspect tasks ────────────────────────────────────────

for (const t of await scheduler.list()) {
  console.log(`  ${t.id}`);
  console.log(`    schedule   : ${t.schedule}`);
  console.log(`    enabled    : ${t.enabled}`);
  console.log(`    next run   : ${t.nextRunAt}`);
  console.log(`    invocations: ${t.invocationCount}`);
  console.log();
}

// ─── 5. Manual trigger (bypasses cron) ───────────────────────

console.log('Manually triggering heartbeat...');
await scheduler.trigger('heartbeat');

const heartbeat = await scheduler.get('heartbeat');
console.log(`  → invocationCount: ${heartbeat!.invocationCount}`);
console.log(`  → lastResult    : ${heartbeat!.lastResult}\n`);

// ─── 6. Remove a task ────────────────────────────────────────

await scheduler.remove('cleanup');
const remaining = await scheduler.list();
console.log(`After removing 'cleanup': ${remaining.length} tasks remaining\n`);

// ─── 7. Custom store (JSON file, DB, etc.) ───────────────────

class LoggingStore extends InMemoryTaskStore {
  async save(task: Parameters<InMemoryTaskStore['save']>[0]): Promise<void> {
    console.log(`  [store] Saving task "${task.id}"`);
    await super.save(task);
  }
}

const persistent = new TaskScheduler({ store: new LoggingStore() });
await persistent.schedule({
  id: 'persistent-task',
  schedule: { cron: '0 0 * * *' },
  task: async () => { console.log('Midnight task ran'); },
});

console.log('Stored in LoggingStore:');
const stored = await persistent.list();
for (const t of stored) {
  console.log(`  ${t.id} → ${t.schedule}`);
}

// ─── 8. Cleanup ──────────────────────────────────────────────

await scheduler.dispose();
await persistent.dispose();
console.log('\nSchedulers disposed.');
