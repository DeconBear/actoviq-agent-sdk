import path from 'node:path';

import {
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

async function main() {
  await loadSettings();

  const sdk = await createAgentSdk({
    agents: [
      {
        name: 'reviewer',
        description: 'Review project changes and report the sharpest findings first.',
        systemPrompt:
          'You are a careful reviewer. Prioritize bugs, regressions, and missing verification.',
      },
    ],
    skills: [
      skill({
        name: 'release-check',
        description: 'Review release readiness and summarize the sharpest blockers.',
        whenToUse:
          'Use when preparing a release and you want a concise pass over blockers, risks, and next checks.',
        prompt: [
          'You are executing the /release-check skill.',
          '',
          'Review the current repository state and summarize:',
          '1. The top release blockers, if any.',
          '2. The most important validation that still needs to happen.',
          '3. The safest next action.',
          '',
          'Task:',
          '$ARGUMENTS',
        ].join('\n'),
        source: 'custom',
        loadedFrom: 'custom',
      }),
      skill({
        name: 'review-with-reviewer',
        description: 'Fork work to the named reviewer agent for a sharper code-review style response.',
        whenToUse:
          'Use when you want a separate reviewer-style pass without changing the main session role.',
        context: 'fork',
        agent: 'reviewer',
        prompt: [
          'You are executing the /review-with-reviewer skill.',
          '',
          'Review the request as a release-focused reviewer and report the sharpest findings first.',
          '',
          'Task:',
          '$ARGUMENTS',
        ].join('\n'),
        source: 'custom',
        loadedFrom: 'custom',
      }),
    ],
  });

  try {
    const available = sdk.skills.listMetadata();
    console.log('Available clean skills:', available.map(entry => entry.name));

    const debugResult = await sdk.runSkill(
      'debug',
      'Explain how this repository can validate a new npm release safely.',
    );
    console.log('\n[debug]');
    console.log(debugResult.text);

    const session = await sdk.createSession({ title: 'Skills Demo' });
    const reviewResult = await session.runSkill(
      'review-with-reviewer',
      'Review whether the current repository looks ready for a publish dry run.',
    );
    console.log('\n[review-with-reviewer]');
    console.log(reviewResult.text);

    const releaseCheck = sdk.skills.use('release-check');
    const releaseResult = await releaseCheck.run(
      'Summarize the safest next release validation step for this repository.',
    );
    console.log('\n[release-check]');
    console.log(releaseResult.text);
  } finally {
    await sdk.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
