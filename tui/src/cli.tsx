#!/usr/bin/env node
import React from 'react';
import os from 'node:os';
import path from 'node:path';
import Ink from './ink/ink.js';
import { App } from './app.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { AlternateScreen } from './ink/components/AlternateScreen.js';

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
      showHelp();
      process.exit(0);
    }
  }
  return opts;
}

function showHelp() {
  console.log(`Actoviq — Terminal AI Agent

Usage: actoviq [options]

Options:
  -p, --project <path>   Project directory (default: cwd)
  -m, --model <name>     Model to use
  -s, --session <id>     Resume session by ID
  -c, --config <path>    Path to settings.json (default: ~/.actoviq/settings.json)
  -h, --help             Show this help

Configuration: ~/.actoviq/settings.json
  {
    "env": {
      "ACTOVIQ_AUTH_TOKEN": "sk-...",
      "ACTOVIQ_MODEL": "claude-sonnet-4-6"
    }
  }

Keybindings: ~/.actoviq/keybindings.json
  Enter       Send message
  Ctrl+C      Abort streaming
  Ctrl+P      Cycle permission mode
  Ctrl+L      Clear screen
  PgUp/PgDn   Scroll messages
  Tab         Complete slash commands
  Up/Down     Navigate history`);
}

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);
  return path.join(os.homedir(), '.actoviq', 'settings.json');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const configPath = resolveConfigPath(opts.configPath);
  const workDir = opts.workDir ?? process.cwd();

  const { loadJsonConfigFile, createAgentSdk, createActoviqCoreTools } =
    await import('actoviq-agent-sdk');

  try {
    await loadJsonConfigFile(configPath);
  } catch {}

  let isGit = false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('git rev-parse --is-inside-work-tree', { cwd: workDir, stdio: 'ignore' });
    isGit = true;
  } catch {}

  const sdk = await createAgentSdk({
    workDir,
    model: opts.model,
    systemPrompt:
      `You are Actoviq, an interactive CLI agent. Your working directory is ${workDir}. Use absolute paths for all file operations.\n\n` +
      `<env>\nWorking directory: ${workDir}\nIs directory a git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\n</env>\n\n` +
      `# Tone and style\n- Only use emojis if the user explicitly requests it.\n- Your responses should be short and concise.\n- When referencing code include the pattern file_path:line_number.\n\n` +
      `# Doing tasks\n- Prefer editing existing files to creating new ones.\n- Do not add features, refactor, or introduce abstractions beyond what the task requires.\n- Default to writing no comments.\n\n` +
      `# Git Safety Protocol\n- NEVER update the git config\n- NEVER run destructive git commands unless the user explicitly requests\n- NEVER skip hooks unless the user explicitly requests it\n- NEVER commit changes unless the user explicitly asks you to\n\n` +
      `# Other\n- NEVER create documentation files (*.md) unless explicitly requested.\n- When in doubt, use TodoWrite to track progress.`,
    tools: createActoviqCoreTools({ cwd: workDir }),
  });

  const ink = new Ink({
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  ink.render(
    <AlternateScreen>
      <ErrorBoundary>
        <App client={sdk} initialModel={opts.model} initialSession={opts.sessionId} />
      </ErrorBoundary>
    </AlternateScreen>
  );
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
