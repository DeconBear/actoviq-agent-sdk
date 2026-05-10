import {
  createActoviqComputerUseToolkit,
  createAgentSdk,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

const executorCalls: string[] = [];

await loadDefaultActoviqSettings();

const toolkit = createActoviqComputerUseToolkit({
  executor: {
    async openUrl(url) {
      executorCalls.push(`open:${url}`);
    },
    async focusWindow(title) {
      executorCalls.push(`focus:${title}`);
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
});

const sdk = await createAgentSdk({
  tools: toolkit.tools,
  mcpServers: [toolkit.mcpServer],
});

try {
  const result = await sdk.run(
    'Use the workflow computer tool to open https://example.com/releases, focus the Example Domain window, write "release-ready" to the clipboard, capture a screenshot, and explain what you did.',
  );

  console.log(result.text);
  console.log('tool calls:', result.toolCalls.map(call => call.publicName));
  console.log('executor calls:', executorCalls);
} finally {
  await sdk.close();
}
