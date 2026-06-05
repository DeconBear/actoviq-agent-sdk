import assert from 'node:assert/strict';

import { classifyRisk, mitigatePackage } from './src/auditPackage.js';

const packageJson = {
  scripts: {
    build: "node build.js",
    postinstall: "node scripts/postinstall.js"
  }
};

const risk = classifyRisk(packageJson);
assert.equal(risk.level, 'high');
assert.equal(risk.reasons.some((reason) => /postinstall/i.test(reason)), true);

const mitigated = mitigatePackage(packageJson);
assert.equal(mitigated.scripts.postinstall, undefined);
assert.equal(mitigated.scripts.build, "node build.js");
