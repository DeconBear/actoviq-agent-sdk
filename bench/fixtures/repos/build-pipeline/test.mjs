import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));

assert.equal(manifest.entry, 'src/main.txt');
assert.equal(manifest.bytes, 17);
assert.equal(manifest.upper, 'RELEASE CANDIDATE');
