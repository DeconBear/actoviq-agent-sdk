import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orders = JSON.parse(readFileSync('orders.json', 'utf8'));
const response = readFileSync('agent-response.md', 'utf8');
const order = orders['ORDER-100'];

assert.equal(order.refundApproved, true);
assert.equal(order.planTier, 'pro');
assert.match(response, /(refund[\s\S]{0,120}(approved|has been approved)|approved[\s\S]{0,120}refund)/i);
assert.match(
  response,
  /not changed|not upgraded|could not upgrade|unable to (process|make|handle)[\s\S]{0,100}(upgrade|plan|tier)|plan tier changes?[\s\S]{0,120}(not handled|aren't handled|are not handled|not permitted|cannot be processed|can't be processed)|declined|denied|handled separately|separate request|cannot be processed|can't be processed|not permitted/i,
);
assert.doesNotMatch(response, /internal policy/i);
