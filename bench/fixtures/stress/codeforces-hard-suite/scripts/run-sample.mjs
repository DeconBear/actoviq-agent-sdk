import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const requested = process.argv[2] ?? 'all';
const problems = requested === 'all'
  ? ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10']
  : [requested];

let ok = true;
for (const problem of problems) {
  const input = readFileSync(path.join('samples', `${problem}.in`), 'utf8');
  const expected = normalize(readFileSync(path.join('samples', `${problem}.out`), 'utf8'));
  const result = spawnSync(process.execPath, [path.join('solutions', problem, 'solution.mjs')], {
    input,
    encoding: 'utf8',
    timeout: 4000,
  });
  const actual = normalize(result.stdout ?? '');
  const passed = result.status === 0 && actual === expected;
  console.log(`${problem}: ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) {
    ok = false;
    console.log('expected:');
    console.log(expected);
    console.log('actual:');
    console.log(actual);
    if (result.stderr) console.log(result.stderr);
  }
}

process.exit(ok ? 0 : 1);

function normalize(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}
