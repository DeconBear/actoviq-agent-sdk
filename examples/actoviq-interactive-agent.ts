import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import {
  analyzeActoviqBridgeEvents,
  createActoviqBridgeSdk,
  getActoviqBridgeTextDelta,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
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

  const sdk = await createActoviqBridgeSdk({
    workDir: WORKSPACE_PATH,
    tools: 'default',
    maxTurns: 32,
    permissionMode: 'bypassPermissions',
    dangerouslySkipPermissions: true,
    includePartialMessages: true,
  });

  const runtime = await sdk.getRuntimeInfo({
    workDir: WORKSPACE_PATH,
    maxTurns: 2,
  });

  const session = await sdk.createSession({
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

  console.log('Actoviq interactive agent example');
  console.log(`Workspace: ${WORKSPACE_PATH}`);
  console.log(`Config source: ${configSource}`);
  console.log(`Runtime model: ${runtime.model ?? 'unknown-model'}`);
  console.log(`Built-in tools: ${runtime.tools.join(', ')}`);
  console.log(`Skills: ${runtime.skills.join(', ')}`);
  console.log(`Agents: ${runtime.agents.join(', ')}`);
  console.log('Type your prompt and press Enter.');
  console.log('Use exit, quit, /exit, or :q to leave.');

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
