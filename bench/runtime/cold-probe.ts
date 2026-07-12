import { performance } from 'node:perf_hooks';

const started = performance.now();
const [{ AgentRuntime }, { ModelRegistry }] = await Promise.all([
  import('../../src/runtime-v2/index.js'),
  import('../../src/providers-v2/index.js'),
]);
const runtime = new AgentRuntime({ models: new ModelRegistry() });
const durationMs = Math.max(0, performance.now() - started);
await runtime.close();

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  operation: 'core-import-and-agent-runtime-create',
  durationMs,
}));
