import { spawnSync } from 'node:child_process';

const judgeScript = process.env.ACTOVIQ_CP_HARD_JUDGE_SCRIPT;
const problem = process.argv[2] ?? 'all';

if (!judgeScript) {
  console.error('ACTOVIQ_CP_HARD_JUDGE_SCRIPT is not configured.');
  process.exit(2);
}

const result = spawnSync(process.execPath, [judgeScript, 'practice', problem], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 300000,
  maxBuffer: 1024 * 1024,
});

if (result.status === 0) {
  console.log('PASS');
  process.exit(0);
}

console.log('FAIL');
process.exit(1);
