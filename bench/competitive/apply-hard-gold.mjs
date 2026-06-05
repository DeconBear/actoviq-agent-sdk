import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hardSolutionSources } from './hard-reference.mjs';

const workspace = process.cwd();

for (const [problem, source] of Object.entries(hardSolutionSources)) {
  const filePath = path.join(workspace, 'solutions', problem, 'solution.mjs');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${source.trim()}\n`, 'utf8');
}
