import assert from 'node:assert/strict';

import { buildSessionPayload } from './src/sessionClient.js';

assert.deepEqual(buildSessionPayload({ token: 'abc', retryCount: 5 }), {
  auth: { token: 'abc' },
  retry: { maxAttempts: 5 },
  telemetry: false,
});
