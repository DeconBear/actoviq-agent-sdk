import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareRuntimeBenchmarkReports } from './comparison.js';

export async function compareRuntimeBenchmarkCli(
  args = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(args);
  const [baseline, current] = await Promise.all([
    readJson(options.baseline),
    readJson(options.current),
  ]);
  const comparison = compareRuntimeBenchmarkReports(current, baseline, {
    thresholdPercent: options.threshold,
    ...(options.acknowledgement
      ? { acknowledgement: { reason: options.acknowledgement } }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  return comparison.status === 'failed' ? 1 : 0;
}

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new TypeError(`Unexpected argument: ${arg}.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`${arg} requires a value.`);
    values.set(arg.slice(2), value);
  }
  for (const required of ['baseline', 'current']) {
    if (!values.get(required)) throw new TypeError(`--${required} is required.`);
  }
  const threshold = values.has('threshold') ? Number(values.get('threshold')) : 10;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError('--threshold must be a non-negative number.');
  }
  const supported = new Set(['baseline', 'current', 'threshold', 'acknowledge']);
  for (const name of values.keys()) {
    if (!supported.has(name)) throw new TypeError(`Unknown option --${name}.`);
  }
  return {
    baseline: values.get('baseline')!,
    current: values.get('current')!,
    threshold,
    acknowledgement: values.get('acknowledge'),
  };
}

async function readJson(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8')) as unknown;
}

if (isMain(import.meta.url)) {
  compareRuntimeBenchmarkCli().then(
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
