/**
 * PowerShell tool — matches Claude Code PowerShellTool schema.
 * Bash is in ./bash/BashTool.ts
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

export const POWERSHELL_TOOL_NAME = 'PowerShell';

export const POWERSHELL_DESCRIPTION =
  'Executes a given PowerShell command and returns its output.\n\n' +
  'IMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets.\n' +
  'DO NOT use it for file operations (reading, writing, editing, searching, finding files) — use the dedicated tools instead.\n\n' +
  'PowerShell edition: Windows PowerShell 5.1 (powershell.exe)\n' +
  '   - Pipeline chain operators `&&` and `||` are NOT available — they cause a parser error.\n' +
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
    async ({ command }) => {
      // PowerShell execution — returns placeholder, actual exec needs platform-specific handling
      return { command, note: 'PowerShell execution requires Windows platform.' };
    },
  );
}
