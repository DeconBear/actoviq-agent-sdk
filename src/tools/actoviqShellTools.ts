import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

import { ToolExecutionError } from '../errors.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

export const POWERSHELL_TOOL_NAME = 'PowerShell';
const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const POWERSHELL_DESCRIPTION =
  'Executes a given PowerShell command and returns its output.\n\n' +
  'IMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets.\n' +
  'DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the dedicated tools instead.\n\n' +
  'PowerShell edition: Windows PowerShell 5.1 (powershell.exe)\n' +
  '   - Pipeline chain operators `&&` and `||` are NOT available - they cause a parser error.\n' +
  '   - Ternary (`?:`), null-coalescing (`??`), and null-conditional (`?.`) operators are NOT available.\n' +
  '   - Avoid `2>&1` on native executables.\n' +
  '   - Default file encoding is UTF-16 LE (with BOM).\n\n' +
  'PowerShell Syntax Notes:\n' +
  '   - Variables use $ prefix: $myVar = "value"\n' +
  '   - Escape character is backtick (`), not backslash\n' +
  '   - Use Verb-Noun cmdlet naming: Get-ChildItem, Set-Location, New-Item, Remove-Item';

export function createPowerShellTool(): AgentToolDefinition {
  return tool(
    {
      name: POWERSHELL_TOOL_NAME,
      description: POWERSHELL_DESCRIPTION,
      inputSchema: z.strictObject({
        command: z.string().describe('The PowerShell command to execute'),
        description: z.string().optional().describe('Clear, concise description of what this command does in active voice.'),
        timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000).'),
      }),
      isDestructive: () => true,
    },
    async ({ command, timeout }, context) => {
      if (process.platform !== 'win32') {
        throw new ToolExecutionError(
          POWERSHELL_TOOL_NAME,
          'PowerShell execution requires Windows.',
        );
      }

      const timeoutMs = Math.min(
        Math.max(1, timeout ?? DEFAULT_TIMEOUT_MS),
        MAX_TIMEOUT_MS,
      );

      try {
        const result = await execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
          {
            cwd: context.cwd,
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        return {
          command,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          exitCode: 0,
        };
      } catch (error) {
        const execError = error as Error & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: number | string;
          signal?: string;
        };
        return {
          command,
          stdout: String(execError.stdout ?? '').trim(),
          stderr: String(execError.stderr ?? execError.message).trim(),
          exitCode: typeof execError.code === 'number' ? execError.code : 1,
          signal: execError.signal,
        };
      }
    },
  );
}
