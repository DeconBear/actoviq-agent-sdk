import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const release = JSON.parse(readFileSync('release.json', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');

assert.equal(release.version, '1.4.0');
assert.equal(release.tests, 'pass');
assert.match(changelog, /## 1\.4\.0/);
