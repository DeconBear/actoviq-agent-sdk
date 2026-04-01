import {
  createActoviqBridgeSdk,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  maxTurns: 4,
});

try {
  const agents = await sdk.agents.list();
  const skills = await sdk.skills.listMetadata();
  const tools = await sdk.tools.listMetadata();
  const slashCommands = await sdk.slashCommands.listMetadata();
  const catalog = await sdk.getRuntimeCatalog();

  console.log('Agents:', agents.map(agent => agent.name));
  console.log('Skills:', skills);
  console.log('Tools:', tools);
  console.log('Slash commands:', slashCommands);
  console.log('Catalog summary:', {
    agents: catalog.agents.length,
    skills: catalog.skills.length,
    tools: catalog.tools.length,
    slashCommands: catalog.slashCommands.length,
  });

  const reviewer = sdk.useAgent('general-purpose');
  const reviewerResult = await reviewer.run('Briefly explain what this repository is for.');
  console.log('Agent result:', reviewerResult.text);

  const debugSkill = sdk.useSkill('debug');
  const skillResult = await debugSkill.run(
    'briefly explain what kinds of debugging help this runtime can provide without printing secrets, tokens, or full config values',
  );
  console.log('Skill result:', skillResult.text);
  console.log('Debug skill metadata:', await debugSkill.metadata());

  const compactResult = await sdk.context.compact('summarize current progress in one short paragraph');
  console.log('Compact result:', compactResult.text);
} finally {
  await sdk.close();
}
