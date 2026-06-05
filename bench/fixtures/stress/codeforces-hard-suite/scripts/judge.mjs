import { spawnSync } from 'node:child_process';

const problem = process.argv[2] ?? 'all';
const judgeScript = process.env.ACTOVIQ_CP_JUDGE_SCRIPT;

if (!judgeScript) {
  console.error('FAIL');
  process.exit(1);
}

const result = spawnSync(process.execPath, [judgeScript, 'practice', problem], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 300000,
});

const passed = result.status === 0 && String(result.stdout).trim() === 'PASS';
console.log(passed ? 'PASS' : 'FAIL');
process.exit(passed ? 0 : 1);
