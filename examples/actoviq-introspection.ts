import { createActoviqBridgeSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
});

try {
  const runtime = await sdk.getRuntimeInfo();
  const agents = await sdk.listAgents();
  const context = await sdk.getContextUsage();

  console.log('Runtime Model:', runtime.model);
  console.log('Runtime Tools:', runtime.tools);
  console.log('Runtime Skills:', runtime.skills);
  console.log('Runtime Slash Commands:', runtime.slashCommands);
  console.log('Agents:', agents);
  console.log('Context Categories:', context.categories);
  console.log('Context Skills:', context.skills);
} finally {
  await sdk.close();
}
