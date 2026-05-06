import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

// ============================================================
// Parallel & Race Primitives Example
//
// parallel() — run multiple independent tasks concurrently
//              with configurable concurrency and fail-fast.
// race()     — run tasks and return the first to complete,
//              with optional timeout.
// ============================================================

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

// ---- 1. parallel() — run independent analyses concurrently ----
console.log('=== parallel() example ===');

const results = await sdk.parallel(
  [
    () => sdk.run('Summarize the project in one sentence.'),
    () => sdk.run('List the top 3 action items from the codebase.'),
    () => sdk.run('Review the code structure for potential issues.'),
  ],
  { maxConcurrency: 3 }, // run all 3 at once
);

console.log('Summary:', results[0]?.text);
console.log('Todo:', results[1]?.text);
console.log('Review:', results[2]?.text);

// ---- 2. parallel() with failFast ----
console.log('\n=== parallel() with failFast ===');

try {
  await sdk.parallel(
    [
      () => sdk.run('Analyze this code.'),
      () => sdk.run('Find bugs in the implementation.'),
      () => sdk.run('Write documentation.'),
    ],
    { maxConcurrency: 2, failFast: true },
  );
  console.log('All tasks completed successfully.');
} catch (err) {
  console.error('One of the tasks failed:', (err as Error).message);
}

// ---- 3. race() — use the fastest model ----
console.log('\n=== race() example ===');

const fastestReply = await sdk.race(
  [
    () => sdk.run('What is 2 + 2?', { model: 'claude-haiku-4-5' }),
    () => sdk.run('What is 2 + 2?', { model: 'claude-sonnet-4-6' }),
  ],
  { timeoutMs: 30_000 }, // 30 second timeout
);

console.log('Fastest reply:', fastestReply.text);

// ---- 4. race() with timeout ----
console.log('\n=== race() with short timeout ===');

try {
  await sdk.race(
    [() => sdk.run('Write a detailed analysis of the entire codebase.')],
    { timeoutMs: 5_000 },
  );
} catch (err) {
  console.log('Race timed out as expected:', (err as Error).message);
}
