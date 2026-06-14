import { z } from 'zod';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool } from '../../runtime/tools.js';
import type { AgentToolDefinition } from '../../types.js';
import { BASH_DESCRIPTION } from './prompt.js';

export const BASH_TOOL_NAME = 'Bash';
const execFile = promisify(execFileCallback);

const inputSchema = z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000)'),
  description: z.string().optional().describe(
    'Clear, concise description of what this command does in active voice.\n\n' +
    'For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n' +
    '- ls → "List files in current directory"\n' +
    '- git status → "Show working tree status"\n' +
    '- npm install → "Install package dependencies"\n\n' +
    'For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n' +
    '- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"\n' +
    '- git reset --hard origin/main → "Discard all local changes and match remote main"\n' +
    '- curl -s url | jq \'.data[]\' → "Fetch JSON from URL and extract data array elements"',
  ),
  run_in_background: z.boolean().optional().describe('Set to true to run this command in the background. Use Read to read the output later.'),
  dangerouslyDisableSandbox: z.boolean().optional().describe('Set this to true to override sandbox mode and run commands without sandboxing.'),
});

export type BashInput = z.infer<typeof inputSchema>;

export function createBashTool(): AgentToolDefinition {
  return tool(
    {
      name: BASH_TOOL_NAME,
      description: BASH_DESCRIPTION,
      inputSchema,
      isDestructive: () => true,
      prompt: () => BASH_DESCRIPTION,
    },
    async (input: BashInput, context) => {
      const timeoutMs = Math.min(Math.max(1, input.timeout ?? 120_000), 600_000);
      const shell = resolveBashShell();
      try {
        if (input.run_in_background) {
          const child = spawn(shell.executable, [...shell.args, input.command], {
            cwd: context.cwd,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
          });
          child.unref();
          return { stdout: '', stderr: '', exitCode: 0, backgroundTaskId: child.pid?.toString() };
        }

        const output = await execFile(shell.executable, [...shell.args, input.command], {
          cwd: context.cwd,
          encoding: 'utf-8',
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          windowsHide: true,
        });
        return {
          stdout: output.stdout.trim(),
          stderr: output.stderr.trim(),
          exitCode: 0,
        };
      } catch (e: any) {
        return {
          stdout: String(e.stdout ?? '').trim(),
          stderr: String(e.stderr ?? e.message ?? e).trim(),
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    },
  );
}

function resolveBashShell(): { executable: string; args: string[] } {
  if (process.platform !== 'win32') {
    return {
      executable: process.env.SHELL || '/bin/bash',
      args: ['-lc'],
    };
  }

  const candidates = [
    process.env.ACTOVIQ_BASH_PATH,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
      : undefined,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : undefined,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) {
    throw new Error(
      'Bash requires Git for Windows. Install Git Bash or set ACTOVIQ_BASH_PATH.',
    );
  }
  return { executable, args: ['-lc'] };
}
