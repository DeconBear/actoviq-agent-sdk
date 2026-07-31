import {
  createAgentSdk,
  createHadamardFileTools,
  loadDefaultHadamardSettings,
} from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings();

const sdk = await createAgentSdk({
  tools: createHadamardFileTools({
    cwd: process.cwd(),
  }),
});

try {
  const result = await sdk.run(
    'Use the Glob tool to find TypeScript files in the examples directory, then use Read to inspect examples/quickstart.ts and summarize what it does.',
    {
      systemPrompt:
        'You are testing Hadamard file tools. Prefer Read, Glob, and Grep when inspecting the local codebase.',
    },
  );

  console.log(result.text);
  console.log('Tool calls:', result.toolCalls.map((call) => call.publicName));
} finally {
  await sdk.close();
}
