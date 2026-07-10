import { z } from 'zod';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool } from '../../runtime/tools.js';
import { isReadOnlyBashCommand } from '../../runtime/bashClassification.js';
import type { ActoviqBackgroundTaskRecord, AgentToolDefinition } from '../../types.js';
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

interface BashBackgroundTaskLauncher {
  launch(options: {
    subagentType: string;
    description: string;
    workDir: string;
    parentRunId?: string;
    parentSessionId?: string;
    agentName?: string;
    outputFile?: string | ((taskId: string) => string);
    onRun: (
      signal: AbortSignal,
      updateProgress: (
        progress: Partial<
          Pick<
            ActoviqBackgroundTaskRecord,
            | 'partialText'
            | 'toolCallCount'
            | 'toolErrorCount'
            | 'requestCount'
            | 'currentIteration'
            | 'currentToolName'
            | 'progressSummary'
            | 'queuedMessageCount'
          >
        >,
      ) => Promise<ActoviqBackgroundTaskRecord>,
      task: ActoviqBackgroundTaskRecord,
    ) => Promise<{
      runId: string;
      sessionId?: string;
      model: string;
      text: string;
      toolCallCount: number;
      toolErrorCount?: number;
      requestCount?: number;
    }>;
    onSettled?: (task: ActoviqBackgroundTaskRecord) => Promise<void> | void;
  }): Promise<ActoviqBackgroundTaskRecord>;
}

export interface BashToolOptions {
  backgroundTaskManager?: BashBackgroundTaskLauncher;
  onBackgroundTaskSettled?: (task: ActoviqBackgroundTaskRecord) => Promise<void> | void;
}

export function createBashTool(options: BashToolOptions = {}): AgentToolDefinition {
  return tool(
    {
      name: BASH_TOOL_NAME,
      description: BASH_DESCRIPTION,
      inputSchema,
      isReadOnly: (input?: BashInput) =>
        typeof input?.command === 'string' && isReadOnlyBashCommand(input.command),
      isDestructive: (input?: BashInput) =>
        !(typeof input?.command === 'string' && isReadOnlyBashCommand(input.command)),
      prompt: () => BASH_DESCRIPTION,
    },
    async (input: BashInput, context) => {
      const blocked = detectDangerousBashCommand(input.command);
      if (blocked) {
        return {
          stdout: '',
          stderr: blocked,
          exitCode: 1,
        };
      }
      const timeoutMs = Math.min(Math.max(1, input.timeout ?? 120_000), 600_000);
      const shell = resolveBashShell();
      try {
        if (input.run_in_background) {
          if (options.backgroundTaskManager) {
            const description = input.description?.trim() || summarizeBashCommand(input.command);
            const task = await options.backgroundTaskManager.launch({
              subagentType: 'bash',
              agentName: 'Bash',
              description,
              workDir: context.cwd,
              parentRunId: context.runId,
              parentSessionId: context.sessionId,
              outputFile: taskId => backgroundBashLogPath(context.cwd, taskId),
              onSettled: options.onBackgroundTaskSettled,
              onRun: async (signal, updateProgress, taskRecord) => {
                await updateProgress({
                  currentToolName: BASH_TOOL_NAME,
                  progressSummary: `Running: ${description}`,
                  requestCount: 0,
                  toolCallCount: 1,
                  toolErrorCount: 0,
                });
                const output = await runBashCommand(shell, input.command, context.cwd, timeoutMs, signal);
                await mkdir(path.dirname(taskRecord.outputFile), { recursive: true });
                await writeFile(taskRecord.outputFile, output.text, 'utf8');
                await updateProgress({
                  partialText: tailText(output.text, 20_000),
                  progressSummary: `Finished with exit code ${output.exitCode}`,
                  toolErrorCount: output.exitCode === 0 ? 0 : 1,
                });
                return {
                  runId: context.runId,
                  sessionId: context.sessionId,
                  model: 'bash',
                  text: output.text,
                  toolCallCount: 1,
                  toolErrorCount: output.exitCode === 0 ? 0 : 1,
                  requestCount: 0,
                };
              },
            });
            return {
              stdout:
                `Background bash task launched.\n` +
                `Task id: ${task.id}\n` +
                `Output: ${task.outputFile}\n` +
                'You will be notified when it completes. Use TaskOutput only for explicit manual inspection.',
              stderr: '',
              exitCode: 0,
              backgroundTaskId: task.id,
              outputFile: task.outputFile,
            };
          }
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

async function runBashCommand(
  shell: { executable: string; args: string[] },
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; text: string }> {
  try {
    const output = await execFile(shell.executable, [...shell.args, command], {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      signal,
    });
    const stdout = output.stdout.trim();
    const stderr = output.stderr.trim();
    return {
      stdout,
      stderr,
      exitCode: 0,
      text: formatBashTaskOutput(command, 0, stdout, stderr),
    };
  } catch (e: any) {
    const stdout = String(e.stdout ?? '').trim();
    const stderr = String(e.stderr ?? e.message ?? e).trim();
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    return {
      stdout,
      stderr,
      exitCode,
      text: formatBashTaskOutput(command, exitCode, stdout, stderr),
    };
  }
}

function formatBashTaskOutput(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): string {
  return [
    `Command: ${command}`,
    `Exit code: ${exitCode}`,
    stdout ? `Stdout:\n${stdout}` : 'Stdout: <empty>',
    stderr ? `Stderr:\n${stderr}` : 'Stderr: <empty>',
  ].join('\n\n');
}

function backgroundBashLogPath(cwd: string, taskId: string): string {
  return path.join(cwd, '.actoviq-artifacts', 'background-bash', `${taskId}.log`);
}

function summarizeBashCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized || 'Background Bash command';
}

function tailText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * Block host-wide process kills that would take down Actoviq itself
 * (e.g. `taskkill /IM node.exe`, `killall node`, `pkill -f node`).
 * Prefer killing a specific PID from the command that started the server.
 */
export function detectDangerousBashCommand(command: string): string | null {
  const cmd = String(command || '');
  // taskkill targeting all node.exe / bun.exe / deno.exe by image name
  if (/\btaskkill\b/i.test(cmd) && /\/(?:IM|FI)\b/i.test(cmd) && /\b(?:node|bun|deno)(?:\.exe)?\b/i.test(cmd) && !/\b\/PID\b/i.test(cmd)) {
    return (
      'Blocked: refusing to kill all node/bun/deno processes by image name ' +
      '(this would terminate Actoviq itself). Kill a specific PID instead ' +
      '(e.g. taskkill /PID <pid> /F), or stop the server you started via its own PID.'
    );
  }
  // killall / pkill of node/bun/deno without a more specific filter that includes a pid
  if (/\bkillall\b/i.test(cmd) && /\b(?:node|bun|deno)\b/i.test(cmd)) {
    return (
      'Blocked: refusing killall on node/bun/deno (would terminate Actoviq). ' +
      'Use kill <pid> for the specific server process instead.'
    );
  }
  if (/\bpkill\b/i.test(cmd) && /(?:^|[\s"'])-f(?:\s|=)/i.test(cmd) && /\b(?:node|bun|deno)\b/i.test(cmd) && !/\b\d{2,}\b/.test(cmd)) {
    return (
      'Blocked: refusing broad pkill -f on node/bun/deno (would terminate Actoviq). ' +
      'Use kill <pid> for the specific server process instead.'
    );
  }
  // PowerShell Stop-Process -Name node (kills every node process)
  if (/\bStop-Process\b/i.test(cmd) && /(?:-Name|-ProcessName)\s+['"]?(?:node|bun|deno)(?:\.exe)?['"]?/i.test(cmd) && !/-Id\b/i.test(cmd)) {
    return (
      'Blocked: refusing Stop-Process -Name node/bun/deno (would terminate Actoviq). ' +
      'Use Stop-Process -Id <pid> for the specific server process instead.'
    );
  }
  return null;
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
