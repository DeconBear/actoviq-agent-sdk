import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import {
  analyzeActoviqBridgeEvents,
  createActoviqBridgeSdk,
  detectBridgeProviders,
  getActoviqBridgeTextDelta,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
  persistActoviqSettingsStore,
  resolveActoviqSettingsStore,
} from 'actoviq-agent-sdk';

const WORKSPACE_PATH = process.cwd();
const JSON_CONFIG_PATH = path.resolve(process.cwd(), 'examples', 'interactive-agent.settings.local.json');
const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', ':q']);

async function ensureFileExists(filePath: string): Promise<void> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    throw new Error(`The config file was not found: ${filePath}`);
  }
}

function summarizeJson(value: unknown): string {
  if (value == null) {
    return '';
  }

  const serialized = JSON.stringify(value);
  if (!serialized) {
    return '';
  }

  return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
}

function shouldExit(input: string): boolean {
  return EXIT_COMMANDS.has(input.trim().toLowerCase());
}

async function main(): Promise<void> {
  let configSource = JSON_CONFIG_PATH;

  try {
    await ensureFileExists(JSON_CONFIG_PATH);
    await loadJsonConfigFile(JSON_CONFIG_PATH);
  } catch {
    await loadDefaultActoviqSettings();
    configSource = '~/.actoviq/settings.json';
  }

  let sdk = await createActoviqBridgeSdk({
    workDir: WORKSPACE_PATH,
    tools: 'default',
    maxTurns: 32,
    permissionMode: 'bypassPermissions',
    dangerouslySkipPermissions: true,
    includePartialMessages: true,
  });

  async function recreateBridgeSdk(): Promise<void> {
    await sdk.close().catch(() => undefined);
    sdk = await createActoviqBridgeSdk({
      workDir: WORKSPACE_PATH,
      tools: 'default',
      maxTurns: 32,
      permissionMode: 'bypassPermissions',
      dangerouslySkipPermissions: true,
      includePartialMessages: true,
    });
  }

  let session = await sdk.createSession({
    title: 'Interactive Agent Example',
    workDir: WORKSPACE_PATH,
    tools: 'default',
    maxTurns: 32,
    permissionMode: 'bypassPermissions',
    dangerouslySkipPermissions: true,
    includePartialMessages: true,
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

  console.log('Actoviq Bridge — interactive agent');
  console.log(`Workspace: ${WORKSPACE_PATH}`);
  console.log(`Config:    ${configSource}`);
  console.log('');

  // Show which runtimes are detected (non-blocking — probe if config is loaded).
  const detections = await detectBridgeProviders();
  for (const d of detections) {
    const mark = d.available ? '✔' : '✘';
    console.log(`  ${mark} ${d.id.padEnd(8)} ${d.version ?? 'not found'}`);
  }
  console.log('');
  console.log('Commands: /bridge (configure runtimes), /providers (re-detect)');
  console.log('Type a prompt and press Enter. Use exit, quit, /exit, or :q to leave.');

  // --- slash-command handlers (closures over the mutable sdk/session + rl) ---

  async function cmdProviders(): Promise<void> {
    console.log('');
    const results = await detectBridgeProviders();
    for (const d of results) {
      const mark = d.available ? '✔' : '✘';
      const ver = d.version ? ` v${d.version}` : ' not found';
      const pathHint = d.path ? ` → ${d.path}` : '';
      console.log(`  ${mark} ${d.id.padEnd(8)} ${ver}${pathHint}`);
    }
  }

  async function cmdBridge(): Promise<void> {
    const results = await detectBridgeProviders();
    console.log('');
    for (let i = 0; i < results.length; i++) {
      const d = results[i]!;
      const mark = d.available ? '✔' : '✘';
      const pathHint = d.path ? ` (${d.path})` : '';
      const verHint = d.version ? ` v${d.version}` : ' not found';
      console.log(`  [${i + 1}] ${d.id}  ${mark}${verHint}${pathHint}`);
    }

    const choice = await rl.question('\nSelect default provider (1-3, Enter to skip)> ');
    const idx = parseInt(choice, 10);
    if (idx < 1 || idx > 3) return;

    const provider = results[idx - 1]!;
    const store = await resolveActoviqSettingsStore();
    const raw: Record<string, unknown> = structuredClone(store.raw);
    const bridge: Record<string, unknown> = (raw.bridge as Record<string, unknown>) ?? {};
    bridge.defaultProvider = provider.id;
    raw.bridge = bridge;
    await persistActoviqSettingsStore(store.configPath, raw);
    await loadJsonConfigFile(store.configPath);

    const pathOverride = await rl.question(
      `Executable path for ${provider.id} (Enter to use auto-detection)> `,
    );
    if (pathOverride.trim()) {
      const store2 = await resolveActoviqSettingsStore();
      const raw2: Record<string, unknown> = structuredClone(store2.raw);
      const bridge2: Record<string, unknown> = (raw2.bridge as Record<string, unknown>) ?? {};
      const providers: Record<string, unknown> = (bridge2.providers as Record<string, unknown>) ?? {};
      providers[provider.id] = { ...(providers[provider.id] as Record<string, unknown> ?? {}), path: pathOverride.trim() };
      bridge2.providers = providers;
      raw2.bridge = bridge2;
      await persistActoviqSettingsStore(store2.configPath, raw2);
      await loadJsonConfigFile(store2.configPath);
    }

    await recreateBridgeSdk();
    session = await sdk.createSession({
      title: 'Interactive Agent Example',
      workDir: WORKSPACE_PATH,
      tools: 'default',
      maxTurns: 32,
      permissionMode: 'bypassPermissions',
      dangerouslySkipPermissions: true,
      includePartialMessages: true,
    });

    console.log(`\n✓ Default provider set to ${provider.id}. Session recreated.\n`);
    await cmdProviders();
  }

  // --- input loop ---

  try {
    while (true) {
      let prompt = '';

      try {
        prompt = (await rl.question('\nYou> ')).trim();
      } catch {
        break;
      }

      if (!prompt) {
        continue;
      }

      if (shouldExit(prompt)) {
        break;
      }

      // Dispatch slash commands before treating as a normal prompt.
      if (prompt.startsWith('/bridge')) {
        await cmdBridge();
        continue;
      }
      if (prompt.startsWith('/providers')) {
        await cmdProviders();
        continue;
      }

      const stream = session.stream(prompt);
      let printedText = false;
      const bufferedEvents = [];

      for await (const event of stream) {
        bufferedEvents.push(event);
        const delta = getActoviqBridgeTextDelta(event);
        if (delta) {
          if (!printedText) {
            process.stdout.write('\nAgent> ');
            printedText = true;
          }
          process.stdout.write(delta);
        }
      }

      const result = await stream.result;
      const analysis = analyzeActoviqBridgeEvents(bufferedEvents);

      if (printedText) {
        process.stdout.write('\n');
      } else if (result.text.trim()) {
        console.log(`\nAgent> ${result.text}`);
      }

      if (result.initEvent) {
        const tools = Array.isArray(result.initEvent.tools) ? result.initEvent.tools.length : 0;
        const skills = Array.isArray(result.initEvent.skills) ? result.initEvent.skills.length : 0;
        const agents = Array.isArray(result.initEvent.agents) ? result.initEvent.agents.length : 0;
        const model =
          typeof result.initEvent.model === 'string' ? result.initEvent.model : 'unknown-model';
        console.log(`\n[session ready] ${result.sessionId}`);
        console.log(`[runtime] model=${model} tools=${tools} skills=${skills} agents=${agents}`);
      }

      for (const request of analysis.toolRequests) {
        const inputSummary = summarizeJson(request.input);
        console.log(`\n[tool request] ${request.name}${inputSummary ? ` ${inputSummary}` : ''}`);
      }

      for (const task of analysis.taskInvocations) {
        const subject = task.subagentType ?? 'inherit';
        const label = task.description ?? task.prompt ?? 'no-task-prompt';
        console.log(`[task] subagent=${subject} prompt=${label}`);
      }

      for (const toolResult of analysis.toolResults) {
        const status = toolResult.isError ? 'error' : 'ok';
        console.log(`\n[tool result] ${toolResult.toolUseId} (${status})`);
      }

      console.log(
        `[turn complete] session=${result.sessionId} turns=${result.numTurns ?? 'unknown'} status=${result.subtype ?? 'unknown'}`,
      );

      if (result.isError && result.stderr.trim()) {
        console.log(`[stderr] ${result.stderr.trim()}`);
      }
    }
  } finally {
    rl.close();
    await sdk.close();
  }

  console.log('\nInteractive session closed.');
}

await main();
