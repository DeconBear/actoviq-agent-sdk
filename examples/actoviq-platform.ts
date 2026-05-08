import path from 'node:path';

import {
  createAgentSdk,
  createActoviqFileTools,
  createTempWorkspace,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
} from 'actoviq-agent-sdk';

// ============================================================
// Platform-level features: workspaces, swarm, session memory,
// and dream — consolidated into one example.
// ============================================================

const JSON_CONFIG_PATH = path.resolve(
  process.cwd(),
  'examples',
  'actoviq-skills.settings.local.json',
);

async function loadSettings() {
  try {
    await loadJsonConfigFile(JSON_CONFIG_PATH);
    console.log(`[setup] Loaded config from ${JSON_CONFIG_PATH}`);
  } catch {
    await loadDefaultActoviqSettings();
    console.log('[setup] Loaded default settings from ~/.actoviq/settings.json');
  }
}

async function main() {
  await loadSettings();

  // ==========================================================
  // 1. Workspaces — sandboxed filesystem for isolated sessions
  // ==========================================================
  console.log('=== 1. Workspaces ===\n');

  const workspace = await createTempWorkspace({
    prefix: 'actoviq-platform-',
    copyFrom: path.resolve(process.cwd(), 'examples'),
  });
  console.log(`Temp workspace: ${workspace.path}`);

  const sdk = await createAgentSdk({
    workDir: workspace.path,
    tools: createActoviqFileTools({ cwd: workspace.path }),
    agents: [
      {
        name: 'reviewer',
        description: 'Review project changes and report the sharpest findings first.',
        systemPrompt: 'You are a concise reviewer. Prioritize bugs and regressions.',
      },
    ],
  });

  try {
    // Verify workspace is isolated
    const wsResult = await sdk.run(
      'Use Glob to list *.ts files in the current directory.',
    );
    console.log('Workspace files:', wsResult.text.slice(0, 200));

    // ==========================================================
    // 2. Swarm — multi-agent team coordination
    // ==========================================================
    console.log('\n=== 2. Swarm ===\n');

    const team = sdk.swarm.createTeam({
      name: 'review-team',
      leader: 'lead',
      continuous: false,
    });

    const spawned = await team.spawn({
      name: 'reviewer-1',
      agent: 'reviewer',
      prompt: 'Review the current workspace and give one sentence assessment.',
    });
    console.log('Spawned result:', spawned.result?.text?.slice(0, 200));

    await team.message(
      'reviewer-1',
      'Leader note: focus on any issues visible in the file list.',
    );

    const mailboxTurn = await team.teammate('reviewer-1').continueFromMailbox();
    console.log('Mailbox turn:', mailboxTurn?.result?.text?.slice(0, 200));

    await team.waitForIdle();

    const inbox = await team.inbox();
    console.log(`Leader inbox: ${inbox.length} messages`);
    for (const msg of inbox) {
      console.log(`  [${msg.kind}] ${msg.from}: ${msg.text?.slice(0, 100)}`);
    }

    // ==========================================================
    // 3. Session Memory — extract + compact long-running sessions
    // ==========================================================
    console.log('\n=== 3. Session Memory ===\n');

    const memSession = await sdk.createSession({ title: 'Memory Demo' });
    await memSession.send(
      'Remember: package.json version must be bumped before creating a Git tag. '
      + 'CI must be green before publishing.',
    );
    await memSession.send(
      'Also: prefer small reviewable commits. Verify release notes before tagging.',
    );

    const extraction = await memSession.extractMemory();
    console.log('Memory extraction:', {
      success: extraction.success,
      updated: extraction.updated,
      trigger: extraction.trigger,
    });

    const compact = await memSession.compactState({
      includeSessionMemory: true,
      includeSummaryMessage: true,
    });
    console.log('Compact progress:', compact.progress);
    console.log('Runtime state:', compact.runtimeState);

    // ==========================================================
    // 4. Dream — background memory consolidation
    // ==========================================================
    console.log('\n=== 4. Dream ===\n');

    await sdk.memory.updateSettings({ autoDreamEnabled: true });
    const dreamSession = await sdk.createSession({ title: 'Dream Demo' });

    const dreamState = await dreamSession.dreamState();
    console.log('Dream state before:', dreamState);

    const dreamResult = await dreamSession.dream({
      extraContext: 'Consolidate durable repository facts and release workflow notes.',
    });
    console.log('Dream result:', {
      skipped: dreamResult.skipped,
      reason: dreamResult.reason,
      touchedSessions: dreamResult.touchedSessions,
      touchedFiles: dreamResult.touchedFiles,
    });

    console.log('\n=== All platform features demonstrated ===');
  } finally {
    await sdk.close();
    await workspace.dispose();
    console.log('Workspace disposed.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
