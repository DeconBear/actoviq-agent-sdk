import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

const executorCalls: string[] = [];

await loadDefaultActoviqSettings();

const sdk = await createAgentSdk({
  computerUse: {
    executor: {
      async openUrl(url) {
        executorCalls.push(`open:${url}`);
      },
      async typeText(text) {
        executorCalls.push(`type:${text}`);
      },
      async keyPress(keys) {
        executorCalls.push(`keys:${keys.join('+')}`);
      },
      async readClipboard() {
        return 'demo clipboard';
      },
      async writeClipboard(text) {
        executorCalls.push(`clipboard:${text}`);
      },
      async takeScreenshot(outputPath) {
        executorCalls.push(`screenshot:${outputPath}`);
        return outputPath;
      },
    },
  },
});

try {
  const result = await sdk.run(
    'Use the workflow computer tool to open https://example.com, type "release-ready", press Enter, wait briefly, and explain what you did.',
  );

  console.log(result.text);
  console.log('tool calls:', result.toolCalls.map(call => call.publicName));
  console.log('executor calls:', executorCalls);
} finally {
  await sdk.close();
}
