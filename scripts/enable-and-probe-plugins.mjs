/**
 * Enable managed plugins locally and probe real availability.
 * Usage: node scripts/enable-and-probe-plugins.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distCatalog = path.join(root, 'dist', 'src', 'plugins', 'managedPluginCatalog.js');
const distHealth = path.join(root, 'dist', 'src', 'plugins', 'managedPluginHealth.js');
const distRuntime = path.join(root, 'dist', 'src', 'plugins', 'managedPluginRuntime.js');

async function loadModule(filePath) {
  return import(pathToFileURL(filePath).href);
}

const settingsPath = path.join(os.homedir(), '.hadamard', 'settings.json');
await mkdir(path.dirname(settingsPath), { recursive: true });
let raw = {};
try {
  raw = JSON.parse(await readFile(settingsPath, 'utf8'));
} catch {
  raw = {};
}
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

const { patchManagedPluginSettings, readManagedPluginCatalog, MANAGED_PLUGIN_IDS } = await loadModule(distCatalog);
const { probeManagedPlugin } = await loadModule(distHealth);
const { createManagedPluginRuntime } = await loadModule(distRuntime);

const installs = [
  { id: 'computer-use', config: { backend: 'local' } },
  { id: 'github', config: {} },
  { id: 'kimi-webbridge', config: { autoStart: true } },
  { id: 'playwright', config: { headless: true, channel: 'chromium' } },
  { id: 'tavily', config: {} },
  { id: 'exa', config: {} },
];

for (const item of installs) {
  patchManagedPluginSettings(raw, item.id, {
    enabled: true,
    ...item.config,
  });
}

await writeFile(settingsPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');

const catalog = readManagedPluginCatalog(raw);
console.log('=== catalog after install ===');
for (const plugin of catalog.plugins) {
  console.log(`${plugin.id.padEnd(16)} enabled=${String(plugin.enabled).padEnd(5)} state=${plugin.state.padEnd(12)} secret=${plugin.secretConfigured}`);
}

console.log('\n=== health probes ===');
for (const id of MANAGED_PLUGIN_IDS) {
  const result = await probeManagedPlugin(raw, id, { cwd: process.cwd() });
  console.log(`${id.padEnd(16)} ${result.state.padEnd(12)} ${result.detail || ''}`);
}

console.log('\n=== runtime tool mount ===');
const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
console.log('enabled:', runtime.enabledPluginIds.join(', '));
console.log('tools:', runtime.tools.map(t => t.name).join(', '));

const tavilyTool = runtime.tools.find(t => t.name === 'TavilySearch');
if (tavilyTool) {
  console.log('\n=== live TavilySearch ===');
  const out = await tavilyTool.execute(
    { query: 'Hadamard agent SDK', depth: 'basic', max_results: 2, include_answer: true },
    { cwd: process.cwd(), signal: AbortSignal.timeout(25_000) },
  );
  console.log(String(out).slice(0, 700));
} else {
  console.log('\n=== live TavilySearch === SKIPPED (not mounted)');
}

const exaTool = runtime.tools.find(t => t.name === 'ExaSearch');
if (exaTool) {
  console.log('\n=== live ExaSearch ===');
  const out = await exaTool.execute(
    { query: 'Hadamard agent SDK', type: 'fast', num_results: 2 },
    { cwd: process.cwd(), signal: AbortSignal.timeout(25_000) },
  );
  console.log(String(out).slice(0, 700));
} else {
  console.log('\n=== live ExaSearch === SKIPPED (not mounted / needs API key)');
}

const github = runtime.tools.find(t => t.name === 'github_status');
if (github) {
  console.log('\n=== live github_status ===');
  console.log(await github.execute({}, { cwd: process.cwd() }));
}

const browser = runtime.tools.find(t => t.name === 'browser_navigate');
if (browser) {
  console.log('\n=== live browser_navigate ===');
  try {
    const nav = await browser.execute(
      { url: 'https://example.com' },
      { cwd: process.cwd(), signal: AbortSignal.timeout(60_000) },
    );
    console.log(nav);
    const snap = runtime.tools.find(t => t.name === 'browser_snapshot');
    if (snap) {
      const shot = await snap.execute({}, { cwd: process.cwd(), signal: AbortSignal.timeout(30_000) });
      console.log('snapshot url/title:', shot?.url, shot?.title, 'elements:', shot?.elements?.length);
    }
  } catch (error) {
    console.log('browser live failed:', error instanceof Error ? error.message : error);
  }
}

const computer = runtime.tools.find(t => t.name === 'computer_wait');
if (computer) {
  console.log('\n=== live computer_wait ===');
  console.log(await computer.execute({ durationMs: 50 }, { cwd: process.cwd() }));
}

await runtime.close().catch((error) => {
  console.log('runtime close warning:', error instanceof Error ? error.message : error);
});

console.log('\nDONE');
