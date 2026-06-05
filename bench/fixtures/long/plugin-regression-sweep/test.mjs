import assert from 'node:assert/strict';

import { buildDiagnostics, discoverPlugins, validatePlugin } from './src/registry.js';

const plugins = discoverPlugins('plugins');
assert.deepEqual(plugins.map((plugin) => plugin.name), ['alpha-tools', 'gamma-tools']);

const invalid = {
  name: 'broken-tools',
  commands: [
    { name: 'scan' },
    { handler: 'missing-name.js' }
  ]
};
const validation = validatePlugin(invalid);
assert.equal(validation.valid, false);
assert.equal(validation.errors.some((error) => error.includes('handler')), true);
assert.equal(validation.errors.some((error) => error.includes('command name')), true);

const diagnostics = buildDiagnostics(invalid);
assert.equal(diagnostics.status, 'invalid');
assert.equal(diagnostics.errors.length >= 2, true);
