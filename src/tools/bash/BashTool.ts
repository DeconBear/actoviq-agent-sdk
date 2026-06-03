import { z } from 'zod';
import { execSync, spawn } from 'node:child_process';
import { tool } from '../../runtime/tools.js';
import type { AgentToolDefinition } from '../../types.js';
import { BASH_DESCRIPTION } from './prompt.js';

export const BASH_TOOL_NAME = 'Bash';

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
      try {
        if (input.run_in_background) {
          // For background execution, spawn detached and return immediately
          const child = spawn(input.command, {
            cwd: context.cwd,
            shell: true,
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
          return { stdout: '', stderr: '', exitCode: 0, backgroundTaskId: child.pid?.toString() };
        }

        const output = execSync(input.command, {
          cwd: context.cwd,
          encoding: 'utf-8',
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { stdout: output.trim(), stderr: '', exitCode: 0 };
      } catch (e: any) {
        return {
          stdout: (e.stdout ?? '').trim(),
          stderr: (e.stderr ?? e.message ?? String(e)).trim(),
          exitCode: e.status ?? 1,
        };
      }
    },
  );
}
