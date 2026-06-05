import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const problem = process.argv[2];
if (!problem) {
  console.error('Usage: npm run run -- h01 < input.txt');
  process.exit(2);
}

const solution = path.join('solutions', problem, 'solution.mjs');
if (!existsSync(solution)) {
  console.error(`Missing ${solution}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [solution], {
  input: readFileSync(0, 'utf8'),
  encoding: 'utf8',
  timeout: 10000,
  maxBuffer: 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
