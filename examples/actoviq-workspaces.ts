import path from 'node:path';

import {
  createTempWorkspace,
  createWorkspace,
  createAgentSdk,
  createActoviqFileTools,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const seededWorkspace = await createWorkspace({
  path: path.resolve(process.cwd(), 'tmp-workspace-demo'),
  ensureExists: true,
});

const tempWorkspace = await createTempWorkspace({
  prefix: 'actoviq-example-',
  copyFrom: path.resolve(process.cwd(), 'examples'),
});

console.log('Seeded workspace:', seededWorkspace.path);
console.log('Temp workspace:', tempWorkspace.path);

const sdk = await createAgentSdk({
  workDir: tempWorkspace.path,
  tools: createActoviqFileTools({
    cwd: tempWorkspace.path,
  }),
});

try {
  const result = await sdk.run(
    'Use Glob to inspect this workspace and tell me which example files are available.',
    {
      systemPrompt: 'Use the provided file tools to inspect the current workspace.',
    },
  );

  console.log(result.text);
} finally {
  await sdk.close();
  await tempWorkspace.dispose();
}
