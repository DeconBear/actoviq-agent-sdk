#!/usr/bin/env node
/**
 * Hadamard TUI entry point.
 *
 * Usage: hadamard-tui [work-dir] [--config <path>] [--permission-mode <mode>] [--model <model>]
 *
 * Runtime defaults: default Hadamard settings loading,
 * createHadamardCoreTools({ cwd }), bypassPermissions, and
 * uncapped tool iterations.
 */
import { runHadamardTui } from '../tui/hadamardTui.js';
import type { HadamardPermissionMode } from '../types.js';
import { readPackageVersion } from './version.js';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']);

function parseArgs(argv: string[]): {
  workDir?: string;
  configPath?: string;
  permissionMode?: HadamardPermissionMode;
  model?: string;
  resumeSessionId?: string;
  continueMostRecent?: boolean;
  help?: boolean;
  version?: boolean;
} {
  const result: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--config' && argv[index + 1]) {
      result.configPath = argv[++index];
    } else if (arg === '--permission-mode' && argv[index + 1]) {
      const mode = argv[++index]!;
      if (!PERMISSION_MODES.has(mode)) {
        process.stderr.write(`Unknown permission mode: ${mode}\n`);
        process.exit(1);
      }
      result.permissionMode = mode as HadamardPermissionMode;
    } else if (arg === '--model' && argv[index + 1]) {
      result.model = argv[++index];
    } else if (arg === '--resume' && argv[index + 1]) {
      result.resumeSessionId = argv[++index];
    } else if (arg === '--continue') {
      result.continueMostRecent = true;
    } else if (!arg.startsWith('-') && !result.workDir) {
      result.workDir = arg;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(1);
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (args.version) {
  process.stdout.write(`${readPackageVersion(import.meta.url)}\n`);
  process.exit(0);
}

if (args.help) {
  process.stdout.write(
    [
      'hadamard-tui — Clean SDK terminal UI',
      '',
      'Usage: hadamard-tui [work-dir] [options]',
      '',
      'Options:',
      '  --config <path>            Load a specific Hadamard settings JSON file',
      '  --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)',
      '  --model <model>            Override the configured model',
      '  --resume <session-id>      Resume a stored Clean SDK session',
      '  --continue                 Resume the most recent stored session',
      '  -v, --version              Show package version',
      '  -h, --help                 Show this help',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('hadamard-tui requires an interactive terminal (TTY).\n');
  process.exit(1);
}

runHadamardTui(args).catch((error) => {
  process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exit(1);
});
