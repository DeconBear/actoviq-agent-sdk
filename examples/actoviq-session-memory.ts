import {
  createAgentSdk,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  workDir: process.cwd(),
});

try {
  const session = await sdk.createSession({
    title: 'Session Memory Demo',
  });

  await session.send(
    'We are preparing the next release. Keep in mind that package.json should be bumped before creating the Git tag, and CI should be green before publishing.',
  );
  await session.send(
    'Also remember that we want small reviewable commits, and the next step is to verify release notes before tagging.',
  );

  const extraction = await session.extractMemory();
  const compactState = await session.compactState({
    includeSessionMemory: true,
    includeSummaryMessage: true,
  });

  console.log('Extraction:', {
    success: extraction.success,
    skipped: extraction.skipped,
    updated: extraction.updated,
    trigger: extraction.trigger,
    memoryPath: extraction.memoryPath,
    reason: extraction.reason,
  });
  console.log('Runtime memory state:', compactState.runtimeState);
  console.log('Progress:', compactState.progress);
  console.log('Session memory summary preview:', compactState.sessionMemory?.content?.slice(0, 400));
} finally {
  await sdk.close();
}
