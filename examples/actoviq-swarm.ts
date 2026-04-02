import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  agents: [
    {
      name: 'reviewer',
      description: 'Review release tasks and summarize the important findings.',
      systemPrompt: 'You are a concise release reviewer. Focus on actionable findings.',
    },
  ],
});

try {
  const team = sdk.swarm.createTeam({
    name: 'release-team',
    leader: 'lead',
  });

  const spawned = await team.spawn({
    name: 'reviewer-1',
    agent: 'reviewer',
    prompt: 'Review the current release plan and list the two most important checks.',
  });

  console.log('spawned result:', spawned.result?.text);

  await team.message(
    'reviewer-1',
    'Leader note: focus on release blockers and anything that could break publish.',
  );

  const task = await team.runBackground(
    'reviewer-1',
    'Now suggest one follow-up check we should automate in CI.',
  );

  console.log('background task:', task.id);

  await team.waitForIdle();

  const inbox = await team.inbox();
  console.log('leader inbox:');
  for (const message of inbox) {
    console.log(`- [${message.kind}] ${message.from}: ${message.text}`);
  }
} finally {
  await sdk.close();
}
