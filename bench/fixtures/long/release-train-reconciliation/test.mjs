import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { reconcileReleaseTrain } from './src/reconcile.js';

const manifest = JSON.parse(await readFile('manifest/release-train.json', 'utf8'));
const result = reconcileReleaseTrain(manifest);

assert.equal(result.compatible, true);
assert.equal(result.blockedItems, 0);
assert.equal(JSON.stringify(result.waves).includes('blocked-addon'), false);

for (const wave of result.waves) {
  assert.equal(wave.packages.length <= manifest.capacityPerWave, true);
}

const flat = result.waves.flatMap((wave) => wave.packages);
assert.equal(flat.indexOf('core') < flat.indexOf('api'), true);
assert.equal(flat.indexOf('api') < flat.indexOf('web'), true);
assert.equal(result.riskSummary.high, 1);
