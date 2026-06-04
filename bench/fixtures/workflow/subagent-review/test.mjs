import assert from 'node:assert/strict';

import { validateConfig, validateReport } from './src/validators.js';

assert.equal(validateConfig({
  runtime: {
    model: 'medium',
    timeoutMs: 1000,
  },
}), true);

assert.equal(validateReport({
  status: 'ready',
  checks: [
    { name: 'build', passed: true },
    { name: 'tests', passed: true },
  ],
}), true);

assert.equal(validateReport({
  status: 'ready',
  checks: [
    { name: 'build', passed: true },
    { name: 'tests', passed: false },
  ],
}), false);
