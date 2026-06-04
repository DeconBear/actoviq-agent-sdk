import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('build.config.json', 'utf8'));
const source = readFileSync(config.input, 'utf8').trim();
mkdirSync('dist', { recursive: true });
writeFileSync('dist/manifest.json', JSON.stringify({
  input: config.input,
  bytes: source.length,
  upper: source.toUpperCase(),
}, null, 2));
