import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const report = readFileSync('release-report.md', 'utf8');

assert.match(report, /ready/i);
assert.match(report, /tests?.*(pass|passed)|pass(ed)?.*tests?/i);
assert.match(report, /changelog.*(updated|present|1\.4\.0)|1\.4\.0.*changelog/i);
