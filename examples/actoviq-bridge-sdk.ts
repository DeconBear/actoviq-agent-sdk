import { createActoviqBridgeSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  maxTurns: 4,
});

try {
  const result = await sdk.run(
    'Use Actoviq Runtime built-in tools to inspect the examples directory, then summarize what examples/quickstart.ts does.',
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
