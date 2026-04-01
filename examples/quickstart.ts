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

try {
  const result = await sdk.run('Please use the add_numbers tool to calculate 8 + 13.', {
    tools: [addNumbers],
    systemPrompt: 'Use the provided tools whenever they are relevant.',
  });

  console.log('Result:', result.text);
  console.log('Tool calls:', result.toolCalls.length);
} finally {
  await sdk.close();
}
