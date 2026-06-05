import assert from 'node:assert/strict';

import { loadRuntimeConfig } from './src/configLoader.js';

const config = loadRuntimeConfig('config/current.json');
assert.equal(config.modelProvider, 'actoviq-openai-compatible');
assert.equal(config.timeoutMs, 4500);
assert.equal(config.retryBudget, 3);
