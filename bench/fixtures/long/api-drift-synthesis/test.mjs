import assert from 'node:assert/strict';

import { buildRequest, parseJobResponse } from './src/client.js';

const request = buildRequest({ jobId: 'job-1', requestTimeoutMs: 8000, maxAttempts: 5, idempotencyKey: 'idem-1' });
assert.equal(request.endpoint, '/api/v3/jobs');
assert.deepEqual(request.body, {
  jobId: 'job-1',
  requestTimeoutMs: 8000,
  maxAttempts: 5,
  idempotencyKey: 'idem-1'
});

const response = parseJobResponse({
  job: { id: 'job-1', state: 'queued' },
  retry: { nextPollMs: 250 }
});
assert.deepEqual(response, { jobId: 'job-1', status: 'queued', nextPollMs: 250 });
