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
    } else if (arg === '--help' || arg === '-h') {
      const bindings = loadKeybindings();
      console.log(`Actoviq TUI Agent

Usage: actoviq [options]

Options:
  -p, --project <path>   Project directory (default: cwd)
  -m, --model <name>     Model to use (e.g. claude-medium-4-6)
  -s, --session <id>     Resume session by ID
  -h, --help             Show this help

Configuration:
  ~/.actoviq/settings.json    API keys, model, and other settings
  ~/.actoviq/keybindings.json Custom keyboard shortcuts

Example settings.json:
  {
    "ACTOVIQ_API_KEY": "sk-...",
    "ACTOVIQ_MODEL": "claude-medium-4-6"
  }

Keybindings (configure in ~/.actoviq/keybindings.json):
  ${describeBinding(bindings)}
`);
      process.exit(0);
    }
  }
  return opts;
}

async function loadActoviqConfig(): Promise<Record<string, string>> {
  const homeDir = os.homedir();
  const settingsPath = path.join(homeDir, '.actoviq', 'settings.json');

  try {
    const { loadJsonConfigFile } = await import('actoviq-agent-sdk');
    const config = await loadJsonConfigFile(settingsPath);
    return config.env ?? {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Load ~/.actoviq/settings.json (API key, model, etc.)
  const configEnv = await loadActoviqConfig();
  for (const [key, value] of Object.entries(configEnv)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  const { createAgentSdk, createActoviqFileTools, createActoviqWebTools } = await import('actoviq-agent-sdk');

  const workDir = opts.workDir ?? process.cwd();
  const sdk = await createAgentSdk({
    workDir,
    model: opts.model,
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
