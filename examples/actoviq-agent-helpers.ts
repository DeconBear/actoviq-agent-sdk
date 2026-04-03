import path from 'node:path';

import {
  createActoviqComputerUseToolkit,
  createActoviqFileTools,
  createAgentSdk,
  loadJsonConfigFile,
  loadDefaultActoviqSettings,
  skill,
} from 'actoviq-agent-sdk';

const JSON_CONFIG_PATH = path.resolve(
  process.cwd(),
  'examples',
  'actoviq-skills.settings.local.json',
);

async function loadSettings() {
  try {
    await loadJsonConfigFile(JSON_CONFIG_PATH);
    console.log(`Loaded config from ${JSON_CONFIG_PATH}`);
    return;
  } catch {
    await loadDefaultActoviqSettings();
    console.log('Loaded config from ~/.actoviq/settings.json');
  }
}

await loadSettings();

const toolkit = createActoviqComputerUseToolkit({
  executor: {
    async openUrl(url) {
      console.log('[computer] openUrl', url);
    },
    async focusWindow(title) {
      console.log('[computer] focusWindow', title);
    },
    async typeText(text) {
      console.log('[computer] typeText', text);
    },
    async keyPress(keys) {
      console.log('[computer] keyPress', keys.join('+'));
    },
    async readClipboard() {
      return 'example clipboard';
    },
    async writeClipboard(text) {
      console.log('[computer] writeClipboard', text);
    },
    async takeScreenshot(outputPath) {
      console.log('[computer] takeScreenshot', outputPath);
      return outputPath;
    },
  },
});

const sdk = await createAgentSdk({
  workDir: process.cwd(),
  tools: createActoviqFileTools({ cwd: process.cwd() }),
  mcpServers: [toolkit.mcpServer],
  agents: [
    {
      name: 'reviewer',
      description: 'Review release work and summarize risks first.',
      systemPrompt: 'Be concise and highlight the sharpest release risks first.',
    },
  ],
  skills: [
    skill({
      name: 'release-check',
      description: 'Review release readiness and summarize blockers.',
      prompt: 'You are executing the /release-check skill.\n\nTask:\n$ARGUMENTS',
      inheritDefaultTools: false,
      inheritDefaultMcpServers: false,
      allowedTools: [],
    }),
  ],
});

try {
  const tools = await sdk.tools.listMetadata();
  const slashCommands = sdk.slashCommands.listMetadata();
  const context = await sdk.context.describe();

  console.log('Agents:', sdk.agents.list().map(agent => agent.name));
  console.log('Skills:', sdk.skills.listMetadata().map(skillDefinition => skillDefinition.name));
  console.log('Tools:', tools.map(toolDefinition => `${toolDefinition.name}:${toolDefinition.category}`));
  console.log('Slash commands:', slashCommands.map(command => command.name));
  console.log('Context:\n', context);

  const reviewerResult = await sdk.runWithAgent(
    'reviewer',
    'Briefly explain what this repository is for.',
  );
  console.log('Agent result:', reviewerResult.text);

  const skillResult = await sdk.runSkill(
    'release-check',
    'Explain what should be validated before publishing the next npm release.',
  );
  console.log('Skill result:', skillResult.text);

  const session = await sdk.createSession({ title: 'Clean helper demo' });
  await session.send(
    'In one short paragraph, explain what should go into a release summary for this repository. Do not modify any files.',
  );
  const compact = await sdk.context.compact(session.id, {
    force: true,
    preserveRecentMessages: 1,
  });
  console.log('Compact result:', compact);
} finally {
  await sdk.close();
}
