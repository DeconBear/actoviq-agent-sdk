import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadRuntimeConfig } from './src/config.js';

const raw = JSON.parse(readFileSync('config.json', 'utf8'));
assert.deepEqual(loadRuntimeConfig(raw), {
  endpoint: 'https://api.example.test',
  timeoutMs: 15000,
});
