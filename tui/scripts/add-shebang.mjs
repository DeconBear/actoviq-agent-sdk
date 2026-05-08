import { readFileSync, writeFileSync } from 'node:fs';

const f = 'dist/cli.js';
const c = readFileSync(f, 'utf8');
if (!c.startsWith('#!')) {
  writeFileSync(f, `#!/usr/bin/env node\n${c}`);
  console.log('[build] Added shebang to dist/cli.js');
}
