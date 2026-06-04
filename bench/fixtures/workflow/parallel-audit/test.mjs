import assert from 'node:assert/strict';

import { summarizeAudit } from './src/audit.js';
import { buildReleasePlan } from './src/planner.js';

const release = {
  releaseDate: '2026-07-01',
  milestones: [
    { id: 'docs', due: '2026-06-29', status: 'ready' },
    { id: 'api', due: new Date('2026-06-20T00:00:00.000Z'), status: 'blocked' },
    { id: 'legacy', due: '2026-06-15', status: 'cancelled' },
  ],
  checks: [
    { id: 'security', severity: 'critical', passed: false, owner: 'sam' },
    { id: 'docs', severity: 'warning', passed: false, owner: '' },
    { id: 'tests', severity: 'warning', passed: true, owner: 'qa' },
  ],
};

const plan = buildReleasePlan(release);
assert.equal(plan.releaseDate, '2026-07-01');
assert.deepEqual(plan.milestoneIds, ['api', 'docs']);
assert.equal(plan.nextBlockedMilestone, 'api');

const audit = summarizeAudit(release);
assert.equal(audit.status, 'blocked');
assert.deepEqual(audit.blockers, ['security', 'docs']);
assert.equal(audit.riskScore, 7);
assert.equal(audit.summary, 'blocked: 2 blockers, risk 7');
