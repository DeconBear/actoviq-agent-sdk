import { z } from 'zod';

import { createAgentSdk, loadDefaultActoviqSettings, tool } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: 'Add two numbers together.',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);

async function main(): Promise<void> {
  console.log('Running live smoke test using a preloaded JSON config file...');

  const runResult = await sdk.run('You must use the add_numbers tool to calculate 12 + 30. Return the final number.', {
    tools: [addNumbers],
    systemPrompt: 'When the user asks for arithmetic, you must call the provided tool before answering.',
    maxTokens: 256,
  });

  if (runResult.toolCalls.length === 0) {
    throw new Error('Live smoke test failed: the model did not call the add_numbers tool.');
  }

  const session = await sdk.createSession({ title: 'Smoke Test Session' });
  const sessionResult = await session.send('Reply with one short sentence confirming the SDK session is working.');

  let deltaCount = 0;
  const stream = sdk.stream('Reply with exactly two words that mean success.');
  for await (const event of stream) {
    if (event.type === 'response.text.delta') {
      deltaCount += 1;
    }
  }
  const streamed = await stream.result;

  if (!streamed.text.trim()) {
    throw new Error('Live smoke test failed: stream result was empty.');
  }

  console.log('Run text:', runResult.text);
  console.log('Session text:', sessionResult.text);
  console.log('Stream text:', streamed.text);
  console.log('Stream deltas:', deltaCount);
  console.log('Smoke test completed successfully.');
}

try {
  await main();
} finally {
  await sdk.close();
}
