import assert from 'node:assert/strict';

import { createSessionPayload, normalizeSessionResponse } from './packages/client/src/sessionClient.js';
import { startSession } from './packages/server/src/sessionServer.js';

const payload = createSessionPayload({ userId: 'u1', maxAttempts: 4, retryDelayMs: 150 });
assert.deepEqual(payload, { userId: 'u1', maxAttempts: 4, retryDelayMs: 150 });
assert.throws(() => createSessionPayload({ userId: 'u1', maxAttempts: 0, retryDelayMs: 150 }), /maxAttempts/);

const serverResponse = startSession(payload);
assert.equal(serverResponse.route, '/v2/session/start');
assert.equal(serverResponse.headers['x-session-id'], 'sess-u1');

const normalized = normalizeSessionResponse(serverResponse);
assert.deepEqual(normalized, {
  sessionId: 'sess-u1',
  expiresAt: '2026-06-30T00:00:00.000Z',
  maxAttempts: 4
});
