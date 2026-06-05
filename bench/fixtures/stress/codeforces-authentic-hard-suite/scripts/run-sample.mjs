import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const requested = process.argv[2] ?? 'all';
const problems = requested === 'all'
  ? ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10']
  : [requested];

for (const problem of problems) {
  const solution = path.join('solutions', problem, 'solution.mjs');
  const inputPath = path.join('samples', `${problem}.in`);
  const outputPath = path.join('samples', `${problem}.out`);
  if (!existsSync(solution)) {
    console.log(`${problem} FAIL missing solution`);
    process.exitCode = 1;
    continue;
  }
  const result = spawnSync(process.execPath, [solution], {
    input: readFileSync(inputPath, 'utf8'),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  const actual = normalize(result.stdout);
  const expected = normalize(readFileSync(outputPath, 'utf8'));
  if (result.status === 0 && actual === expected) {
    console.log(`${problem} PASS`);
  } else {
    console.log(`${problem} FAIL`);
    if (result.stderr) console.log(result.stderr.trim());
    console.log(`expected: ${expected}`);
    console.log(`actual:   ${actual}`);
    process.exitCode = 1;
  }
}

function normalize(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}
