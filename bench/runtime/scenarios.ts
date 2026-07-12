import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import type { AgentSpec } from '../../src/core/index.js';
import { McpConnectionManager } from '../../src/mcp/connectionManager.js';
import type { MessageParam } from '../../src/provider/types.js';
import {
  LegacyModelApiProvider,
  ModelProviderLegacyAdapter,
} from '../../src/providers-v2/legacy.js';
import { ModelRegistry } from '../../src/providers-v2/registry.js';
import { AsyncQueue } from '../../src/runtime/asyncQueue.js';
import { prepareActoviqProviderRequestMessages } from '../../src/runtime/actoviqApiMicrocompact.js';
import { RuntimeServices } from '../../src/runtime-v2/services.js';
import { RunTreeController } from '../../src/orchestration/scope.js';
import { SqliteStorageV2 } from '../../src/storage-v2/sqliteStorage.js';
import type { ActoviqCompactConfig } from '../../src/types.js';

import { invariant, measureCpu, metric } from './benchmark.js';
import { createFakeMcpClient, DeterministicModelProvider } from './fakes.js';
import type {
  RuntimeBenchmarkInvariant,
  RuntimeBenchmarkMetric,
  RuntimeBenchmarkWorkload,
} from './types.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COLD_PROBE = fileURLToPath(new URL('./cold-probe.ts', import.meta.url));

export interface ScenarioResult {
  readonly metrics: RuntimeBenchmarkMetric[];
  readonly invariants: RuntimeBenchmarkInvariant[];
}

export async function benchmarkRuntimeImportAndCreate(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const coldSamples: number[] = [];
  for (let index = 0; index < workload.samples; index += 1) {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      COLD_PROBE,
    ], {
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { durationMs?: unknown; operation?: unknown };
    if (parsed.operation !== 'core-import-and-agent-runtime-create') {
      throw new Error('Cold runtime probe returned an unexpected operation.');
    }
    if (typeof parsed.durationMs !== 'number') {
      throw new Error('Cold runtime probe did not return durationMs.');
    }
    coldSamples.push(parsed.durationMs);
  }

  const [{ AgentRuntime }] = await Promise.all([
    import('../../src/runtime-v2/index.js'),
  ]);
  for (let index = 0; index < workload.warmupIterations; index += 1) {
    const runtime = new AgentRuntime({ models: new ModelRegistry() });
    await runtime.close();
  }
  const warmSamples: number[] = [];
  for (let index = 0; index < workload.samples; index += 1) {
    const started = performance.now();
    const runtime = new AgentRuntime({ models: new ModelRegistry() });
    warmSamples.push(Math.max(0, performance.now() - started));
    await runtime.close();
  }

  return {
    metrics: [
      metric({
        id: 'runtime.import_create.cold',
        scenario: 'runtime-import-create',
        variant: 'cold-isolated-process',
        measure: 'latency',
        unit: 'ms',
        samples: coldSamples,
        notes: 'Timer starts inside an isolated Node process and includes core runtime/provider imports plus AgentRuntime construction; process startup is excluded.',
      }),
      metric({
        id: 'runtime.import_create.warm',
        scenario: 'runtime-import-create',
        variant: 'warm-module-cache',
        measure: 'latency',
        unit: 'ms',
        samples: warmSamples,
        notes: 'Cached module import state; measures ModelRegistry and AgentRuntime construction only.',
      }),
    ],
    invariants: [
      invariant(
        'runtime.import_create.sample_count',
        coldSamples.length === workload.samples && warmSamples.length === workload.samples,
        workload.samples,
        { cold: coldSamples.length, warm: warmSamples.length },
      ),
    ],
  };
}

export async function benchmarkMcpCatalog(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const metrics: RuntimeBenchmarkMetric[] = [];
  const invariants: RuntimeBenchmarkInvariant[] = [];

  for (const toolCount of workload.mcpToolCounts) {
    const coldSamples: number[] = [];
    let coldValid = true;
    let coldConnectCalls = 0;
    let coldListCalls = 0;
    for (let sample = 0; sample < workload.samples; sample += 1) {
      const fake = createFakeMcpClient(toolCount);
      const manager = new McpConnectionManager(
        { name: 'runtime-benchmark', version: '1' },
        { clientFactory: () => fake.client, catalogTtlMs: 60_000 },
      );
      const started = performance.now();
      const adapters = await manager.resolveToolAdapters([], [fakeServer(toolCount)]);
      coldSamples.push(Math.max(0, performance.now() - started));
      coldValid &&= adapters.length === toolCount;
      coldConnectCalls += fake.stats.connectCalls;
      coldListCalls += fake.stats.listToolsCalls;
      await manager.closeAll();
    }

    const warmFake = createFakeMcpClient(toolCount);
    const warmManager = new McpConnectionManager(
      { name: 'runtime-benchmark', version: '1' },
      { clientFactory: () => warmFake.client, catalogTtlMs: 60_000 },
    );
    const server = fakeServer(toolCount);
    const primed = await warmManager.resolveToolAdapters([], [server]);
    const warmSamples: number[] = [];
    let warmValid = primed.length === toolCount;
    for (let sample = 0; sample < workload.samples; sample += 1) {
      const started = performance.now();
      const adapters = await warmManager.resolveToolAdapters([], [server]);
      warmSamples.push(Math.max(0, performance.now() - started));
      warmValid &&= adapters.length === toolCount;
    }
    const warmCalls = { ...warmFake.stats };
    await warmManager.closeAll();

    const parameters = { toolCount };
    metrics.push(
      metric({
        id: `mcp.catalog.tools_${toolCount}.cold`,
        scenario: 'mcp-catalog',
        variant: 'cold-connection-and-catalog',
        measure: 'latency',
        unit: 'ms',
        samples: coldSamples,
        parameters,
      }),
      metric({
        id: `mcp.catalog.tools_${toolCount}.warm`,
        scenario: 'mcp-catalog',
        variant: 'warm-ttl-cache',
        measure: 'latency',
        unit: 'ms',
        samples: warmSamples,
        parameters,
      }),
    );
    invariants.push(
      invariant(
        `mcp.catalog.tools_${toolCount}.result_count`,
        coldValid && warmValid,
        toolCount,
        coldValid && warmValid ? toolCount : 'mismatch',
      ),
      invariant(
        `mcp.catalog.tools_${toolCount}.cold_calls`,
        coldConnectCalls === workload.samples && coldListCalls === workload.samples,
        { connect: workload.samples, listTools: workload.samples },
        { connect: coldConnectCalls, listTools: coldListCalls },
      ),
      invariant(
        `mcp.catalog.tools_${toolCount}.warm_cache`,
        warmCalls.connectCalls === 1 && warmCalls.listToolsCalls === 1,
        { connect: 1, listTools: 1 },
        { connect: warmCalls.connectCalls, listTools: warmCalls.listToolsCalls },
        'Priming plus every warm sample must reuse one connection and one catalog response.',
      ),
      invariant(
        `mcp.catalog.tools_${toolCount}.no_tool_calls`,
        warmCalls.callToolCalls === 0,
        0,
        warmCalls.callToolCalls,
      ),
    );
  }
  return { metrics, invariants };
}

export async function benchmarkSqliteSessions(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const metrics: RuntimeBenchmarkMetric[] = [];
  const invariants: RuntimeBenchmarkInvariant[] = [];

  for (const itemCount of workload.sessionItemCounts) {
    const items = createSessionItems(itemCount);
    const appendSamples: number[] = [];
    const loadSamples: number[] = [];
    const snapshotSamples: number[] = [];
    const snapshotLoadSamples: number[] = [];
    let validAppend = true;
    let validLoad = true;
    let validSnapshot = true;

    for (let sample = 0; sample < workload.samples; sample += 1) {
      const storage = await SqliteStorageV2.open({ filename: ':memory:' });
      const key = { tenantId: 'benchmark', sessionId: `items-${itemCount}-${sample}` };
      try {
        await storage.sessions.create(key);
        let started = performance.now();
        const appended = await storage.sessions.append({
          ...key,
          expectedRevision: 0,
          items,
        });
        appendSamples.push(Math.max(0, performance.now() - started));
        validAppend &&= appended.revision === 1 && appended.lastSequence === itemCount;

        started = performance.now();
        const loaded = await storage.sessions.load({ ...key, useSnapshot: false });
        loadSamples.push(Math.max(0, performance.now() - started));
        validLoad &&= loaded.items.length === itemCount
          && loaded.items[0]?.sequence === 1
          && loaded.items.at(-1)?.sequence === itemCount;

        started = performance.now();
        const snapshot = await storage.sessions.compact({
          ...key,
          expectedRevision: appended.revision,
          throughSequence: itemCount,
          state: { itemCount, checksum: deterministicChecksum(itemCount) },
        });
        snapshotSamples.push(Math.max(0, performance.now() - started));
        validSnapshot &&= snapshot.revision === 2 && snapshot.throughSequence === itemCount;

        started = performance.now();
        const afterSnapshot = await storage.sessions.load(key);
        snapshotLoadSamples.push(Math.max(0, performance.now() - started));
        validSnapshot &&= afterSnapshot.snapshot?.throughSequence === itemCount
          && afterSnapshot.items.length === 0;
      } finally {
        await storage.close();
      }
    }

    const parameters = { itemCount, backend: 'node:sqlite-memory' };
    const prefix = `storage.sqlite.items_${itemCount}`;
    metrics.push(
      metric({
        id: `${prefix}.append`,
        scenario: 'sqlite-session',
        variant: 'append-batch',
        measure: 'latency',
        unit: 'ms',
        samples: appendSamples,
        parameters,
      }),
      metric({
        id: `${prefix}.load_full`,
        scenario: 'sqlite-session',
        variant: 'load-before-snapshot',
        measure: 'latency',
        unit: 'ms',
        samples: loadSamples,
        parameters,
      }),
      metric({
        id: `${prefix}.snapshot`,
        scenario: 'sqlite-session',
        variant: 'snapshot-write',
        measure: 'latency',
        unit: 'ms',
        samples: snapshotSamples,
        parameters,
      }),
      metric({
        id: `${prefix}.load_snapshot`,
        scenario: 'sqlite-session',
        variant: 'load-after-snapshot',
        measure: 'latency',
        unit: 'ms',
        samples: snapshotLoadSamples,
        parameters,
      }),
    );
    invariants.push(
      invariant(`${prefix}.append_sequence`, validAppend, itemCount, validAppend ? itemCount : 'mismatch'),
      invariant(`${prefix}.full_load_count`, validLoad, itemCount, validLoad ? itemCount : 'mismatch'),
      invariant(
        `${prefix}.snapshot_tail`,
        validSnapshot,
        { throughSequence: itemCount, tailItems: 0, revision: 2 },
        validSnapshot ? { throughSequence: itemCount, tailItems: 0, revision: 2 } : 'mismatch',
      ),
    );
  }
  return { metrics, invariants };
}

export async function benchmarkBoundedStream(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const durationSamples: number[] = [];
  const heapPeakSamples: number[] = [];
  let observedMaxBuffer = 0;
  let observedMaxRetained = 0;
  let produced = 0;

  for (let sample = 0; sample < workload.samples; sample += 1) {
    const queue = new AsyncQueue<{ type: 'text.delta'; delta: string }>({
      capacity: workload.streamBufferCapacity,
      overflowStrategy: 'drop-oldest',
    });
    const startHeap = process.memoryUsage().heapUsed;
    let peakHeap = startHeap;
    let maxBuffer = 0;
    const started = performance.now();
    for (let index = 0; index < workload.streamDeltaCount; index += 1) {
      queue.push({ type: 'text.delta', delta: String(index & 0xff) });
      maxBuffer = Math.max(maxBuffer, queue.bufferedSize);
      if ((index & 0xfff) === 0) {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }
    }
    durationSamples.push(Math.max(0, performance.now() - started));
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    heapPeakSamples.push(Math.max(0, peakHeap - startHeap));
    produced += workload.streamDeltaCount;
    observedMaxBuffer = Math.max(observedMaxBuffer, maxBuffer);
    queue.close();
    let retained = 0;
    for await (const _event of queue) retained += 1;
    observedMaxRetained = Math.max(observedMaxRetained, retained);
  }

  const parameters = {
    deltaCount: workload.streamDeltaCount,
    capacity: workload.streamBufferCapacity,
    overflowStrategy: 'drop-oldest',
  };
  return {
    metrics: [
      metric({
        id: 'stream.delta.bounded.duration',
        scenario: 'bounded-stream-delta',
        variant: 'drop-oldest',
        measure: 'latency',
        unit: 'ms',
        samples: durationSamples,
        parameters,
      }),
      metric({
        id: 'stream.delta.bounded.heap_peak_delta',
        scenario: 'bounded-stream-delta',
        variant: 'drop-oldest',
        measure: 'memory',
        unit: 'bytes',
        samples: heapPeakSamples,
        parameters,
        regression: false,
        direction: 'informational',
        notes: 'Sampled heap delta is diagnostic only; boundedness is enforced by the buffer invariants, not a machine-specific byte threshold.',
      }),
    ],
    invariants: [
      invariant(
        'stream.delta.bounded.produced',
        produced === workload.streamDeltaCount * workload.samples,
        workload.streamDeltaCount * workload.samples,
        produced,
      ),
      invariant(
        'stream.delta.bounded.max_buffer',
        observedMaxBuffer <= workload.streamBufferCapacity,
        `<= ${workload.streamBufferCapacity}`,
        observedMaxBuffer,
      ),
      invariant(
        'stream.delta.bounded.retained',
        observedMaxRetained <= workload.streamBufferCapacity,
        `<= ${workload.streamBufferCapacity}`,
        observedMaxRetained,
      ),
    ],
  };
}

export async function benchmarkSharedServices(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const metrics: RuntimeBenchmarkMetric[] = [];
  const invariants: RuntimeBenchmarkInvariant[] = [];

  for (const childCount of workload.childCounts) {
    const samples: number[] = [];
    let factoryCalls = 0;
    let allScopesShared = true;
    let allInstancesShared = true;
    for (let sample = 0; sample < workload.samples; sample += 1) {
      let sampleFactoryCalls = 0;
      const service = Object.freeze({
        id: `shared-${childCount}-${sample}`,
        close(): void {},
      });
      const services = new RuntimeServices({
        benchmark: {
          factory: () => {
            factoryCalls += 1;
            sampleFactoryCalls += 1;
            return service;
          },
        },
      });
      const tree = new RunTreeController();
      const started = performance.now();
      const root = tree.createRoot({ runId: `root-${childCount}-${sample}`, services });
      const children = Array.from({ length: childCount }, (_, index) =>
        tree.deriveChild(root, `child-${childCount}-${sample}-${index}`));
      const instances = await Promise.all(
        [root, ...children].map(scope => scope.services.resolve('benchmark')),
      );
      samples.push(Math.max(0, performance.now() - started));
      allScopesShared &&= children.every(child => child.services === services);
      allInstancesShared &&= sampleFactoryCalls === 1
        && instances.every(instance => instance === service);
      for (const child of children) tree.complete(child.runId);
      tree.complete(root.runId);
      await services.close();
    }
    const prefix = `orchestration.shared_services.children_${childCount}`;
    metrics.push(metric({
      id: prefix,
      scenario: 'child-team-shared-services',
      variant: `${childCount}-children`,
      measure: 'latency',
      unit: 'ms',
      samples,
      parameters: { childCount, resolutions: childCount + 1 },
    }));
    invariants.push(
      invariant(
        `${prefix}.scope_identity`,
        allScopesShared,
        'one RuntimeServices object inherited by every child/team member',
        allScopesShared ? 'shared' : 'recreated',
      ),
      invariant(
        `${prefix}.factory_once`,
        allInstancesShared && factoryCalls === workload.samples,
        workload.samples,
        factoryCalls,
        'Concurrent root/child resolution must coalesce to one service instance per run tree.',
      ),
    );
  }
  return { metrics, invariants };
}

export async function benchmarkCompaction(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const messages = compactionMessages(
    workload.compactionToolResults,
    workload.compactionPayloadChars,
  );
  const beforeCpu: number[] = [];
  const transformCpu: number[] = [];
  const afterCpu: number[] = [];
  const beforeBytes: number[] = [];
  const afterBytes: number[] = [];
  let clearedValid = true;
  let structureValid = true;

  for (let sample = 0; sample < workload.samples; sample += 1) {
    const before = measureCpu(() => requestBytes(messages));
    beforeCpu.push(before.cpuMs);
    beforeBytes.push(before.value);

    const transformed = measureCpu(() => prepareActoviqProviderRequestMessages(
      messages,
      COMPACTION_CONFIG,
      { localToolResultMicrocompact: true, force: true },
    ));
    transformCpu.push(transformed.cpuMs);
    clearedValid &&= transformed.value.clearedToolResults
      === Math.max(workload.compactionToolResults - COMPACTION_CONFIG.microcompactKeepRecentToolResults, 0);
    structureValid &&= transformed.value.messages.length === messages.length
      && toolIds(transformed.value.messages).join(',') === toolIds(messages).join(',');

    const after = measureCpu(() => requestBytes(transformed.value.messages));
    afterCpu.push(after.cpuMs);
    afterBytes.push(after.value);
  }

  const parameters = {
    toolResults: workload.compactionToolResults,
    payloadChars: workload.compactionPayloadChars,
    keepRecent: COMPACTION_CONFIG.microcompactKeepRecentToolResults,
  };
  return {
    metrics: [
      metric({
        id: 'compaction.request.before.cpu',
        scenario: 'request-compaction',
        variant: 'before',
        measure: 'cpu',
        unit: 'ms',
        samples: beforeCpu,
        parameters,
      }),
      metric({
        id: 'compaction.transform.cpu',
        scenario: 'request-compaction',
        variant: 'transform',
        measure: 'cpu',
        unit: 'ms',
        samples: transformCpu,
        parameters,
      }),
      metric({
        id: 'compaction.request.after.cpu',
        scenario: 'request-compaction',
        variant: 'after',
        measure: 'cpu',
        unit: 'ms',
        samples: afterCpu,
        parameters,
      }),
      metric({
        id: 'compaction.request.before.bytes',
        scenario: 'request-compaction',
        variant: 'before',
        measure: 'size',
        unit: 'bytes',
        samples: beforeBytes,
        parameters,
      }),
      metric({
        id: 'compaction.request.after.bytes',
        scenario: 'request-compaction',
        variant: 'after',
        measure: 'size',
        unit: 'bytes',
        samples: afterBytes,
        parameters,
      }),
    ],
    invariants: [
      invariant(
        'compaction.cleared_expected_results',
        clearedValid,
        Math.max(workload.compactionToolResults - COMPACTION_CONFIG.microcompactKeepRecentToolResults, 0),
        clearedValid ? 'matched in every sample' : 'mismatch',
      ),
      invariant(
        'compaction.request_bytes_reduced',
        afterBytes.every((value, index) => value < beforeBytes[index]!),
        'after < before for every sample',
        { before: beforeBytes[0], after: afterBytes[0] },
      ),
      invariant(
        'compaction.tool_pair_structure_preserved',
        structureValid,
        'same message count and tool_use/tool_result ids',
        structureValid ? 'preserved' : 'changed',
      ),
    ],
  };
}

export async function benchmarkCompatAdapter(
  workload: RuntimeBenchmarkWorkload,
): Promise<ScenarioResult> {
  const { AgentRuntime } = await import('../../src/runtime-v2/index.js');
  const provider = new DeterministicModelProvider('direct-benchmark');
  const directRuntime = new AgentRuntime({
    models: new ModelRegistry([provider]),
  });
  const compatProvider = new LegacyModelApiProvider({
    id: 'compat-benchmark',
    modelApi: new ModelProviderLegacyAdapter(provider),
  });
  const compatRuntime = new AgentRuntime({
    models: new ModelRegistry([compatProvider]),
  });
  const directAgent: AgentSpec = {
    id: 'direct-agent',
    name: 'Direct benchmark agent',
    instructions: 'Return deterministic output.',
    model: 'direct-benchmark:bench',
  };
  const compatAgent: AgentSpec = {
    ...directAgent,
    id: 'compat-agent',
    name: 'Compatibility benchmark agent',
    model: 'compat-benchmark:bench',
  };
  const directSamples: number[] = [];
  const compatSamples: number[] = [];
  const overheadSamples: number[] = [];
  let outputsEqual = true;

  try {
    for (let index = 0; index < workload.warmupIterations; index += 1) {
      const direct = await directRuntime.run(directAgent, 'benchmark', {
        runId: `compat-warm-direct-${index}`,
      });
      const compat = await compatRuntime.run(compatAgent, 'benchmark', {
        runId: `compat-warm-adapter-${index}`,
      });
      outputsEqual &&= direct.output === compat.output;
    }
    for (let index = 0; index < workload.samples; index += 1) {
      let directDuration: number;
      let compatDuration: number;
      let directOutput: string;
      let compatOutput: string;
      if ((index & 1) === 0) {
        ({ duration: directDuration, output: directOutput } = await timedRuntimeRun(
          directRuntime,
          directAgent,
          `compat-direct-${index}`,
        ));
        ({ duration: compatDuration, output: compatOutput } = await timedRuntimeRun(
          compatRuntime,
          compatAgent,
          `compat-adapter-${index}`,
        ));
      } else {
        ({ duration: compatDuration, output: compatOutput } = await timedRuntimeRun(
          compatRuntime,
          compatAgent,
          `compat-adapter-${index}`,
        ));
        ({ duration: directDuration, output: directOutput } = await timedRuntimeRun(
          directRuntime,
          directAgent,
          `compat-direct-${index}`,
        ));
      }
      directSamples.push(directDuration);
      compatSamples.push(compatDuration);
      overheadSamples.push(compatDuration / Math.max(directDuration, Number.EPSILON));
      outputsEqual &&= directOutput === compatOutput
        && directOutput === provider.text;
    }
  } finally {
    await Promise.all([directRuntime.close(), compatRuntime.close()]);
  }

  return {
    metrics: [
      metric({
        id: 'compat.runtime.direct',
        scenario: 'compat-adapter-overhead',
        variant: 'direct-provider-v2',
        measure: 'latency',
        unit: 'ms',
        samples: directSamples,
      }),
      metric({
        id: 'compat.runtime.adapter',
        scenario: 'compat-adapter-overhead',
        variant: 'provider-v2-through-legacy-roundtrip',
        measure: 'latency',
        unit: 'ms',
        samples: compatSamples,
      }),
      metric({
        id: 'compat.runtime.overhead_ratio',
        scenario: 'compat-adapter-overhead',
        variant: 'adapter-divided-by-direct',
        measure: 'overhead',
        unit: 'ratio',
        samples: overheadSamples,
        notes: 'LegacyModelApiProvider(ModelProviderLegacyAdapter(provider)) versus the same provider through AgentRuntime directly.',
      }),
    ],
    invariants: [
      invariant(
        'compat.runtime.output_equivalence',
        outputsEqual,
        provider.text,
        outputsEqual ? provider.text : 'mismatch',
      ),
      invariant(
        'compat.runtime.no_stream_or_network',
        provider.calls.stream === 0,
        0,
        provider.calls.stream,
      ),
    ],
  };
}

function fakeServer(toolCount: number) {
  return {
    kind: 'stdio' as const,
    name: `fake-${toolCount}`,
    command: 'benchmark-fake-command-never-started',
    args: [`--tools=${toolCount}`],
    stderr: 'ignore' as const,
  };
}

function createSessionItems(itemCount: number) {
  return Array.from({ length: itemCount }, (_, index) => ({
    itemId: `item-${index}`,
    kind: index % 2 === 0 ? 'input' : 'output',
    payload: { index, text: `deterministic-${index & 0xff}` },
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
}

function deterministicChecksum(itemCount: number): number {
  return (itemCount * (itemCount - 1)) / 2;
}

const COMPACTION_CONFIG: ActoviqCompactConfig = {
  enabled: true,
  autoCompactThresholdTokens: 1,
  preserveRecentMessages: 2,
  maxSummaryTokens: 1_000,
  microcompactEnabled: true,
  microcompactKeepRecentToolResults: 3,
  microcompactMinContentChars: 1,
  apiMicrocompactEnabled: true,
  apiMicrocompactMaxInputTokens: 1,
  apiMicrocompactTargetInputTokens: 1,
  apiMicrocompactMaxRequestBytes: 1,
  apiMicrocompactClearToolResults: true,
  apiMicrocompactClearToolUses: false,
  toolResultArtifactMaxChars: 80_000,
  toolResultsPerMessageMaxChars: 200_000,
  loopAutoCompactEnabled: true,
  contextWindowTokens: 200_000,
};

function compactionMessages(toolResults: number, payloadChars: number): MessageParam[] {
  const payload = 'x'.repeat(payloadChars);
  const messages: MessageParam[] = [];
  for (let index = 0; index < toolResults; index += 1) {
    const id = `call-${index}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'benchmark_tool', input: { index } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: `${index}:${payload}` }],
    });
  }
  return messages;
}

function requestBytes(messages: readonly MessageParam[]): number {
  return Buffer.byteLength(JSON.stringify({
    model: 'benchmark:model',
    max_tokens: 1_024,
    messages,
  }));
}

function toolIds(messages: readonly MessageParam[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') ids.push(`use:${String(block.id)}`);
      if (block.type === 'tool_result') ids.push(`result:${String(block.tool_use_id)}`);
    }
  }
  return ids;
}

async function timedRuntimeRun(
  runtime: { run(agent: AgentSpec, input: string, options: { runId: string }): Promise<{ output: string }> },
  agent: AgentSpec,
  runId: string,
): Promise<{ duration: number; output: string }> {
  const started = performance.now();
  const result = await runtime.run(agent, 'benchmark', { runId });
  return { duration: Math.max(0, performance.now() - started), output: result.output };
}
