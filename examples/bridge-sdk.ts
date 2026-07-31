import path from 'node:path';

import { createHadamardBridgeSdk, loadDefaultHadamardSettings } from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings();

const sdk = await createHadamardBridgeSdk({
  ...(process.env.HADAMARD_BRIDGE_EXAMPLE_CLI_PATH
    ? {
        executable: process.execPath,
        cliPath: path.resolve(process.env.HADAMARD_BRIDGE_EXAMPLE_CLI_PATH),
      }
    : {}),
  workDir: process.cwd(),
  maxTurns: 4,
});

try {
  const result = await sdk.run(
    'Use Hadamard Runtime built-in tools to inspect the examples directory, then summarize what examples/quickstart.ts does.',
  );

  console.log('Agents:', result.initEvent?.agents);
  console.log('Skills:', result.initEvent?.skills);
  console.log('Tools:', result.initEvent?.tools);
  console.log('Session ID:', result.sessionId);
  console.log('Subtype:', result.subtype);
  console.log('Text:', result.text);
  console.log('Events:', result.events.length);
} finally {
  await sdk.close();
}
