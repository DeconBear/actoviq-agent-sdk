/**
 * Browser-use style tools demo (Playwright).
 *
 * Uses an injected mock session by default so the example runs without a
 * browser binary. Set HADAMARD_BROWSER_LIVE=1 to drive a real Chromium:
 *
 *   npx playwright install chromium
 *   HADAMARD_BROWSER_LIVE=1 npm run example:hadamard-browser-use
 */
import {
  createHadamardBrowserUseToolkit,
  createAgentSdk,
  loadDefaultHadamardSettings,
} from 'actoviq-agent-sdk';

await loadDefaultHadamardSettings();

const live = process.env.HADAMARD_BROWSER_LIVE === '1';

const toolkit = live
  ? createHadamardBrowserUseToolkit({ headless: true })
  : createHadamardBrowserUseToolkit({
      session: {
        async navigate(url) {
          return { tabId: 't1', url, title: 'Example Domain' };
        },
        async goBack() {
          return { url: 'https://example.com/', title: 'Example Domain' };
        },
        async wait() {},
        async snapshot() {
          return {
            url: 'https://example.com/',
            title: 'Example Domain',
            tabs: [{ id: 't1', url: 'https://example.com/', title: 'Example Domain', active: true }],
            elements: [{ index: 0, tag: 'a', role: 'link', name: 'More information...' }],
            truncated: false,
          };
        },
        async click() {
          return { ok: true as const };
        },
        async type() {
          return { ok: true as const };
        },
        async press() {
          return { ok: true as const };
        },
        async scroll() {
          return { ok: true as const };
        },
        async screenshot() {
          return { base64: '' };
        },
        async tabsDetailed() {
          return [{ id: 't1', url: 'https://example.com/', title: 'Example Domain', active: true }];
        },
        async switchTab(tabId) {
          return { ok: true as const, tabId };
        },
        async closeTab(tabId) {
          return { ok: true as const, closed: tabId ?? 't1' };
        },
        async extract() {
          return {
            url: 'https://example.com/',
            title: 'Example Domain',
            text: 'Example Domain\nThis domain is for use in illustrative examples.',
          };
        },
        async close() {},
      },
    });

const sdk = await createAgentSdk({
  tools: toolkit.tools,
});

try {
  const result = await sdk.run(
    live
      ? 'Use browser_navigate to open https://example.com/, then browser_snapshot, then summarize the page.'
      : 'Call browser_navigate on https://example.com/, then browser_snapshot, and briefly describe the interactive elements returned.',
  );
  console.log(result.text);
  console.log('tool calls:', result.toolCalls.map((call) => call.publicName));
} finally {
  await toolkit.session.close().catch(() => undefined);
  await sdk.close();
}
