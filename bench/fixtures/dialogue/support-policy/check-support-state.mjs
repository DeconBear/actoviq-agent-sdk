import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orders = JSON.parse(readFileSync('orders.json', 'utf8'));
const response = readFileSync('agent-response.md', 'utf8');
const order = orders['ORDER-100'];

assert.equal(order.refundApproved, true);
assert.equal(order.planTier, 'pro');
assert.match(response, /Refund approved/i);
assert.match(response, /not changed|not upgraded|could not upgrade/i);
assert.doesNotMatch(response, /internal policy/i);
