import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRuntimeBenchmarks } from './suite.js';
import type { RuntimeBenchmarkOptions } from './types.js';

export async function runRuntimeBenchmarkCli(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(args);
  const report = await runRuntimeBenchmarks(parsed.options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (parsed.output) {
    const filename = path.resolve(parsed.output);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, json, 'utf8');
  }
  process.stdout.write(json);
  return report.status === 'passed' ? 0 : 1;
}

function parseArgs(args: readonly string[]): {
  options: RuntimeBenchmarkOptions;
  output?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    if (!arg.startsWith('--')) throw new TypeError(`Unexpected argument: ${arg}.`);
    const inline = arg.indexOf('=');
    const name = inline >= 0 ? arg.slice(2, inline) : arg.slice(2);
    const value = inline >= 0 ? arg.slice(inline + 1) : args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`--${name} requires a value.`);
    if (values.has(name)) throw new TypeError(`--${name} was supplied more than once.`);
    values.set(name, value);
  }
  const supported = new Set([
    'mode', 'output', 'samples', 'warmups', 'mcp-tools', 'session-items',
    'stream-deltas', 'stream-capacity', 'children', 'compaction-results',
    'compaction-payload-chars',
  ]);
  for (const name of values.keys()) {
    if (!supported.has(name)) throw new TypeError(`Unknown option --${name}.`);
  }
  const mode = values.get('mode');
  if (mode !== undefined && mode !== 'smoke' && mode !== 'full') {
    throw new TypeError('--mode must be smoke or full.');
  }
  return {
    options: {
      ...(mode ? { mode } : {}),
      ...integerOption(values, 'samples', 'samples'),
      ...integerOption(values, 'warmups', 'warmupIterations', true),
      ...integerListOption(values, 'mcp-tools', 'mcpToolCounts'),
      ...integerListOption(values, 'session-items', 'sessionItemCounts'),
      ...integerOption(values, 'stream-deltas', 'streamDeltaCount'),
      ...integerOption(values, 'stream-capacity', 'streamBufferCapacity'),
      ...integerListOption(values, 'children', 'childCounts'),
      ...integerOption(values, 'compaction-results', 'compactionToolResults'),
      ...integerOption(values, 'compaction-payload-chars', 'compactionPayloadChars'),
    },
    ...(values.get('output') ? { output: values.get('output') } : {}),
  };
}

function integerOption(
  values: ReadonlyMap<string, string>,
  cliName: string,
  property: keyof RuntimeBenchmarkOptions,
  allowZero = false,
): Partial<RuntimeBenchmarkOptions> {
  const raw = values.get(cliName);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`--${cliName} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return { [property]: value };
}

function integerListOption(
  values: ReadonlyMap<string, string>,
  cliName: string,
  property: keyof RuntimeBenchmarkOptions,
): Partial<RuntimeBenchmarkOptions> {
  const raw = values.get(cliName);
  if (raw === undefined) return {};
  const result = raw.split(',').map(value => Number(value.trim()));
  if (result.length === 0 || result.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError(`--${cliName} must be a comma-separated list of positive integers.`);
  }
  return { [property]: result };
}

function usage(): string {
  return [
    'Runtime benchmark options:',
    '  --mode smoke|full',
    '  --output <report.json>',
    '  --samples <n> --warmups <n>',
    '  --session-items 10000,100000 --stream-deltas 1000000',
    '  --mcp-tools 1,10,100 --children 1,4,8,16',
  ].join('\n');
}

if (isMain(import.meta.url)) {
  runRuntimeBenchmarkCli().then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

function isMain(url: string): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(url));
}
