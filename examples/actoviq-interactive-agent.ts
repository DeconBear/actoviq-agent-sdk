import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import {
  createActoviqBridgeSdk,
  loadJsonConfigFile,
  type ActoviqBridgeJsonEvent,
} from 'actoviq-agent-sdk';

const WORKSPACE_PATH = process.cwd();
const JSON_CONFIG_PATH = path.resolve(process.cwd(), 'examples', 'interactive-agent.settings.local.json');
const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', ':q']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function ensureFileExists(filePath: string): Promise<void> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    throw new Error(
      [
        `The config file was not found: ${filePath}`,
        'Create examples/interactive-agent.settings.local.json first, or change JSON_CONFIG_PATH in this example.',
        'A safe template is available at examples/interactive-agent.settings.example.json.',
      ].join(' '),
    );
  }
}

function getTextDelta(event: ActoviqBridgeJsonEvent): string | undefined {
  if (event.type !== 'stream_event' || !isRecord(event.event)) {
    return undefined;
  }

  const nestedEvent = event.event;
  if (nestedEvent.type !== 'content_block_delta' || !isRecord(nestedEvent.delta)) {
    return undefined;
  }

  const delta = nestedEvent.delta;
  return delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : undefined;
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

function printAssistantToolRequests(event: ActoviqBridgeJsonEvent): void {
  if (event.type !== 'assistant' || !isRecord(event.message) || !Array.isArray(event.message.content)) {
    return;
  }

  for (const block of event.message.content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      continue;
    }

    if (
      block.type === 'tool_use' ||
      block.type === 'server_tool_use' ||
      block.type === 'mcp_tool_use'
    ) {
      const toolName = typeof block.name === 'string' ? block.name : 'unknown-tool';
      const inputSummary = summarizeJson(block.input);
      console.log(`\n[tool request] ${toolName}${inputSummary ? ` ${inputSummary}` : ''}`);
    }
  }
}

function printUserToolResults(event: ActoviqBridgeJsonEvent): void {
  if (event.type !== 'user' || !isRecord(event.message) || !Array.isArray(event.message.content)) {
    return;
  }

  for (const block of event.message.content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      continue;
    }

    if (block.type === 'tool_result' || block.type.endsWith('tool_result')) {
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown-tool-call';
      const status = block.is_error === true ? 'error' : 'ok';
      console.log(`\n[tool result] ${toolUseId} (${status})`);
    }
  }
}

function printSessionInit(event: ActoviqBridgeJsonEvent): void {
  if (event.type !== 'system' || event.subtype !== 'init') {
    return;
  }

  const tools = Array.isArray(event.tools) ? event.tools.length : 0;
  const skills = Array.isArray(event.skills) ? event.skills.length : 0;
  const agents = Array.isArray(event.agents) ? event.agents.length : 0;
  const model = typeof event.model === 'string' ? event.model : 'unknown-model';
  const sessionId = typeof event.session_id === 'string' ? event.session_id : 'unknown-session';

  console.log(`\n[session ready] ${sessionId}`);
  console.log(`[runtime] model=${model} tools=${tools} skills=${skills} agents=${agents}`);
}

function shouldExit(input: string): boolean {
  return EXIT_COMMANDS.has(input.trim().toLowerCase());
}

async function main(): Promise<void> {
  await ensureFileExists(JSON_CONFIG_PATH);
  await loadJsonConfigFile(JSON_CONFIG_PATH);

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
  console.log(`Config JSON: ${JSON_CONFIG_PATH}`);
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

      for await (const event of stream) {
        const delta = getTextDelta(event);
        if (delta) {
          if (!printedText) {
            process.stdout.write('\nAgent> ');
            printedText = true;
          }
          process.stdout.write(delta);
          continue;
        }

        printSessionInit(event);
        printAssistantToolRequests(event);
        printUserToolResults(event);
      }

      const result = await stream.result;

      if (printedText) {
        process.stdout.write('\n');
      } else if (result.text.trim()) {
        console.log(`\nAgent> ${result.text}`);
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
