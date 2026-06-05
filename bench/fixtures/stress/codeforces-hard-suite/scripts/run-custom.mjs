import { spawnSync } from 'node:child_process';
import path from 'node:path';

const problem = process.argv[2];
if (!problem) {
  console.error('Usage: npm run run -- p01 < input.txt');
  process.exit(2);
}

const input = await new Promise((resolve) => {
  let text = '';
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
});

const result = spawnSync(process.execPath, [path.join('solutions', problem, 'solution.mjs')], {
  input,
  encoding: 'utf8',
  timeout: 4000,
});

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
