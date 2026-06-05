import assert from 'node:assert/strict';

import { buildAuditSummary, redactSecrets } from './src/redact.js';

const text = [
  'ACTOVIQ_API_KEY=sk-test-abc123',
  'PASSWORD=super-secret',
  'TOKEN=tok_live_456'
].join('\n');

const redacted = redactSecrets(text);
assert.equal(redacted.includes('sk-test-abc123'), false);
assert.equal(redacted.includes('super-secret'), false);
assert.equal(redacted.includes('tok_live_456'), false);
assert.match(redacted, /REDACTED/);

const summary = buildAuditSummary(text);
assert.equal(summary.secretExposure, false);
assert.match(summary.summary, /密钥|secret/i);
