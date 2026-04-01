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
  const skills = await sdk.skills.list();

  console.log('Agents:', agents.map(agent => agent.name));
  console.log('Skills:', skills);

  const reviewer = sdk.useAgent('general-purpose');
  const reviewerResult = await reviewer.run('Briefly explain what this repository is for.');
  console.log('Agent result:', reviewerResult.text);

  const debugSkill = sdk.useSkill('debug');
  const skillResult = await debugSkill.run('summarize the current runtime configuration');
  console.log('Skill result:', skillResult.text);

  const compactResult = await sdk.context.compact('summarize current progress in one short paragraph');
  console.log('Compact result:', compactResult.text);
} finally {
  await sdk.close();
}

