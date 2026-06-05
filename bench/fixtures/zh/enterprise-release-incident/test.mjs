import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildReleasePlan } from './src/releasePlanner.js';
import { summarizeRisks } from './src/riskAudit.js';

const releaseInput = JSON.parse(await readFile('data/release-input.json', 'utf8'));
const riskInput = JSON.parse(await readFile('data/risk-input.json', 'utf8'));

const plan = buildReleasePlan(releaseInput);
assert.deepEqual(plan.milestoneIds, ['m-1', 'm-3', 'm-2']);
assert.equal(plan.nextBlockedMilestone, 'm-3');
assert.equal(plan.releaseDate, '2026-07-01');

const risk = summarizeRisks(riskInput);
assert.equal(risk.status, 'blocked');
assert.deepEqual(risk.blockers, ['chk-db', 'chk-e2e', 'chk-copy']);
assert.equal(risk.riskScore, 8);
assert.match(risk.summary, /3 blockers/);
