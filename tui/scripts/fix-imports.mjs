// Post-build: fix imports that Node.js can't resolve
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

function walk(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, fn);
    else if (entry.endsWith('.js')) fn(full);
  }
}

// 1. Fix global.d.ts → global.js (Node.js can't load .d.ts)
walk(dist, (file) => {
  let content = readFileSync(file, 'utf8');
  if (content.includes("'../global.d.ts'")) {
    writeFileSync(file, content.replace(/'..\/global.d.ts'/g, "'../global.js'"));
  }
});

// 2. Create global.js in dist/ink/
const globalJs = join(dist, 'ink', 'global.js');
writeFileSync(globalJs, 'export {};\n');

// 3. Copy compiled yoga-layout JS to src/ for src/* runtime resolution
import { cpSync, mkdirSync } from 'fs';
const yogaDist = join(dist, 'native-ts', 'yoga-layout');
const yogaSrc = join(__dirname, '..', 'src', 'native-ts', 'yoga-layout');
mkdirSync(yogaSrc, { recursive: true });
cpSync(join(yogaDist, 'index.js'), join(yogaSrc, 'index.js'));
cpSync(join(yogaDist, 'enums.js'), join(yogaSrc, 'enums.js'));

console.log('Post-build fixes applied.');
