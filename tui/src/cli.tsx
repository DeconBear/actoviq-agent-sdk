#!/usr/bin/env node
import React from 'react';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import { App } from './app.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { loadKeybindings, describeBinding } from './lib/keybindings.js';

interface CliOptions {
  workDir?: string;
  model?: string;
  sessionId?: string;
  configPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project' || arg === '-p') {
      opts.workDir = argv[++i];
    } else if (arg === '--model' || arg === '-m') {
      opts.model = argv[++i];
    } else if (arg === '--session' || arg === '-s') {
      opts.sessionId = argv[++i];
    } else if (arg === '--config' || arg === '-c') {
      opts.configPath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      const bindings = loadKeybindings();
      console.log(`Actoviq TUI Agent

Usage: actoviq [options]

Options:
  -p, --project <path>   Project directory (default: cwd)
  -m, --model <name>     Model to use (e.g. claude-sonnet-4-6)
  -s, --session <id>     Resume session by ID
  -c, --config <path>    Path to settings.json (default: ~/.actoviq/settings.json)
  -h, --help             Show this help

Configuration:
  ~/.actoviq/settings.json    API keys, model, and other settings
  ~/.actoviq/keybindings.json Custom keyboard shortcuts

Example settings.json:
  {
    "env": {
      "ACTOVIQ_AUTH_TOKEN": "sk-...",
      "ACTOVIQ_MODEL": "claude-sonnet-4-6"
    }
  }

Keybindings (configure in ~/.actoviq/keybindings.json):
  ${describeBinding(bindings)}
`);
      process.exit(0);
    }
  }
  return opts;
}

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);
  const homeDir = os.homedir();
  return path.join(homeDir, '.actoviq', 'settings.json');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  const configPath = resolveConfigPath(opts.configPath);

  // Use the SDK's built-in config loader which properly handles the { env: {...} }
  // wrapper and stores the result for resolveRuntimeConfig to consume.
  const { loadJsonConfigFile, createAgentSdk, createActoviqFileTools, createActoviqWebTools } =
    await import('actoviq-agent-sdk');

  try {
    await loadJsonConfigFile(configPath);
    process.stderr.write(`[actoviq] Loaded config from ${configPath}\n`);
  } catch (err) {
    process.stderr.write(`[actoviq] Config warning: ${(err as Error).message}\n`);
  }

  const workDir = opts.workDir ?? process.cwd();
  const sdk = await createAgentSdk({
    workDir,
    model: opts.model,
    systemPrompt: `You are Actoviq, an interactive CLI agent. Your working directory is ${workDir}. Use absolute paths for all file operations. Create files in the working directory unless the user specifies otherwise.`,
    tools: [
      ...createActoviqFileTools({ cwd: workDir }),
      ...createActoviqWebTools(),
    ],
  });

  const { waitUntilExit } = render(
    React.createElement(ErrorBoundary, null,
      React.createElement(App, { client: sdk, initialModel: opts.model }),
    ),
    { patchConsole: false },
  );

  try {
    await waitUntilExit();
  } catch (e) {
    console.error('Fatal error:', e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
