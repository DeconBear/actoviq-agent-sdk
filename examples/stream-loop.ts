import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const prompts = [
  'Introduce yourself in one concise sentence.',
  'Now summarize the key idea of your previous sentence in one sentence.',
  'Finally, give two short suggestions that would help a developer call this SDK more reliably.',
];

try {
  const session = await sdk.createSession({ title: 'Stream Loop Example' });

  for (const [index, prompt] of prompts.entries()) {
    console.log(`\n=== Round ${index + 1} ===`);
    console.log(`Prompt: ${prompt}`);
    console.log('Streaming:');

    const stream = session.stream(prompt, {
      systemPrompt: 'Keep the answer concise and direct.',
      maxTokens: 256,
    });

    for await (const event of stream) {
      if (event.type === 'response.text.delta') {
        process.stdout.write(event.delta);
      }
    }

    const result = await stream.result;
    console.log('\n');
    console.log(`Final: ${result.text}`);
    console.log(`Stop reason: ${result.stopReason ?? 'unknown'}`);
  }

  console.log(`\nSession complete: ${session.id}`);
} finally {
  await sdk.close();
}
