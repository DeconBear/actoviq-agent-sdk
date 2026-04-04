import path from 'node:path';

import {
  createAgentSdk,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
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

async function main() {
  await loadSettings();

  const sdk = await createAgentSdk({
    workDir: process.cwd(),
  });

  try {
    await sdk.memory.updateSettings({ autoDreamEnabled: true });
    const session = await sdk.createSession({ title: 'Dream Demo Session' });

    console.log('Dream state before run:');
    console.log(await session.dreamState());

    const result = await session.dream({
      extraContext:
        'Consolidate durable repository facts, release workflow notes, and any stable implementation details worth preserving.',
    });

    console.log('\nDream result summary:');
    console.log({
      skipped: result.skipped,
      reason: result.reason,
      touchedSessions: result.touchedSessions,
      touchedFiles: result.touchedFiles,
      text: result.result?.text,
    });
  } finally {
    await sdk.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
