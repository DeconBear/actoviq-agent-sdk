import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

// ============================================================
// Session Checkpoint Example
//
// Checkpoints let you save and restore session state.
// Useful for:
// - Saving progress before a risky refactor
// - Creating named restore points
// - Experimenting with different approaches
// ============================================================

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

// ---- 1. Basic save and restore ----
const session = await sdk.createSession({ title: 'Checkpoint Demo' });

// Build up some conversation state
await session.send('Remember that the database schema is in db/schema.sql.');
await session.send('The API runs on port 8080.');

// Save a checkpoint before a risky operation
const checkpoint1 = await session.saveCheckpoint('before-refactor');
console.log('Checkpoint saved:', checkpoint1.id, `("${checkpoint1.label}")`);

// Do the risky operation
await session.send('Rename all user-facing endpoints from /api to /v2.');

// Oops, that was wrong — restore the checkpoint
await session.restoreCheckpoint(checkpoint1.id);
console.log('Restored to checkpoint:', checkpoint1.id);

// Verify the state is back
const reply = await session.send('What port does the API run on?');
console.log('After restore — API port remembered:', reply.text.includes('8080'));
// → true — the "rename" conversation is gone

// ---- 2. Multiple checkpoints ----
const experimentSession = await sdk.createSession({ title: 'Experiments' });

// Save baseline
const baseline = await experimentSession.saveCheckpoint('baseline');
console.log('\nBaseline checkpoint:', baseline.id);

// Try approach A
await experimentSession.send('Write a React component with class-based syntax.');
// Save approach A checkpoint
const approachA = await experimentSession.saveCheckpoint('approach-a-class');
console.log('Approach A checkpoint:', approachA.id);

// Restore to baseline and try approach B
await experimentSession.restoreCheckpoint(baseline.id);
await experimentSession.send('Write a React component with hooks-based syntax.');
const approachB = await experimentSession.saveCheckpoint('approach-b-hooks');
console.log('Approach B checkpoint:', approachB.id);

// ---- 3. List and manage checkpoints ----
const checkpoints = await experimentSession.listCheckpoints();
console.log('\nAll checkpoints for experiment session:');
for (const cp of checkpoints) {
  console.log(`  ${cp.id} | "${cp.label}" | created: ${cp.createdAt}`);
}

// Clean up unwanted checkpoint
await experimentSession.deleteCheckpoint(approachA.id);
console.log('\nDeleted approach-a checkpoint.');

const remaining = await experimentSession.listCheckpoints();
console.log('Remaining checkpoints:', remaining.length);
// → 2 (baseline, approach-b-hooks)
