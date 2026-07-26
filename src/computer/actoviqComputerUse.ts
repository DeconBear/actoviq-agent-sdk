import { realpath as realpathCallback } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { signalAborted } from '../runtime/helpers.js';
import { tool } from '../runtime/tools.js';
import type {
  ActoviqComputerUseExecutor,
  AgentToolDefinition,
  CreateActoviqComputerUseOptions,
  LocalMcpServerDefinition,
} from '../types.js';

const realpath = promisify(realpathCallback.native);

export interface ActoviqComputerUseToolkit {
  tools: AgentToolDefinition[];
  mcpServer: LocalMcpServerDefinition;
}

export const ACTOVIQ_COMPUTER_USE_WORKFLOW_ACTIONS = [
  'open_url',
  'focus_window',
  'type_text',
  'keypress',
  'read_clipboard',
  'write_clipboard',
  'take_screenshot',
  'wait',
] as const;

function ensureWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('The default computer-use executor currently supports Windows only.');
  }
}

function killChildProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean }): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    // Best-effort: kill PowerShell and any child it spawned (e.g. Start-Process helpers).
    void import('node:child_process').then(({ execFile }) => {
      execFile(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => undefined,
      );
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Process may already have exited.
  }
}

async function runPowerShell(command: string, signal?: AbortSignal): Promise<string> {
  ensureWindows();
  signalAborted(signal);
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      {
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          finish(() => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(typeof signal.reason === 'string' ? signal.reason : 'The run was aborted.'),
            );
          });
          return;
        }
        if (error) {
          finish(() => {
            reject(new Error(stderr?.trim() || error.message, { cause: error }));
          });
          return;
        }
        finish(() => resolve(stdout.trim()));
      },
    );

    onAbort = () => {
      killChildProcessTree(child);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

export function createDefaultActoviqComputerUseExecutor(): ActoviqComputerUseExecutor {
  return {
    openUrl: (url, signal) =>
      runPowerShell(`Start-Process '${url.replace(/'/g, "''")}'`, signal).then(() => undefined),
    focusWindow: (title, signal) =>
      runPowerShell(
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('${title.replace(/'/g, "''")}')`,
        signal,
      ).then(() => undefined),
    typeText: (text, signal) =>
      runPowerShell(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text.replace(/[{}+^%~()]/g, '{$&}').replace(/'/g, "''")}')`,
        signal,
      ).then(() => undefined),
    keyPress: (keys, signal) =>
      runPowerShell(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.join('+').replace(/'/g, "''")}')`,
        signal,
      ).then(() => undefined),
    readClipboard: (signal) => runPowerShell('Get-Clipboard -Raw', signal),
    writeClipboard: (text, signal) => {
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      return runPowerShell(
        `$bytes=[Convert]::FromBase64String('${encoded}'); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($bytes))`,
        signal,
      ).then(() => undefined);
    },
    takeScreenshot: async (outputPath, signal) => {
      await runPowerShell(
        [
          'Add-Type -AssemblyName System.Windows.Forms;',
          'Add-Type -AssemblyName System.Drawing;',
          '$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
          '$bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height;',
          '$g=[System.Drawing.Graphics]::FromImage($bmp);',
          '$g.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size);',
          `$bmp.Save('${outputPath.replace(/'/g, "''")}');`,
          '$g.Dispose();',
          '$bmp.Dispose();',
        ].join(' '),
        signal,
      );
      return outputPath;
    },
  };
}

function withPrefix(prefix: string | undefined, suffix: string): string {
  return prefix?.trim() ? `${prefix}_${suffix}` : `computer_${suffix}`;
}

const workflowStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open_url'),
    url: z.string().url(),
  }),
  z.object({
    action: z.literal('type_text'),
    text: z.string().min(1),
  }),
  z.object({
    action: z.literal('focus_window'),
    title: z.string().min(1),
  }),
  z.object({
    action: z.literal('keypress'),
    keys: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal('read_clipboard'),
  }),
  z.object({
    action: z.literal('write_clipboard'),
    text: z.string(),
  }),
  z.object({
    action: z.literal('take_screenshot'),
    outputPath: z.string().min(1),
  }),
  z.object({
    action: z.literal('wait'),
    durationMs: z.number().int().min(1).max(60_000),
  }),
]);

type ActoviqComputerWorkflowStep = z.infer<typeof workflowStepSchema>;

async function runAbortable<T>(
  operation: (signal?: AbortSignal) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signalAborted(signal);
  if (!signal) return operation(undefined);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(typeof signal.reason === 'string' ? signal.reason : 'The run was aborted.'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    signalAborted(signal);
    return await Promise.race([Promise.resolve().then(() => operation(signal)), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  signalAborted(signal);
  if (!signal) {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(typeof signal.reason === 'string' ? signal.reason : 'The run was aborted.'),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const hostMutationMetadata = {
  isReadOnly: () => false,
  isDestructive: () => true,
  requiresUserInteraction: () => true,
};

const hostReadMetadata = {
  isReadOnly: () => true,
  isDestructive: () => false,
  requiresUserInteraction: () => true,
};

const passiveMetadata = {
  isReadOnly: () => true,
  isDestructive: () => false,
  requiresUserInteraction: () => false,
};

function isReadOnlyWorkflow(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || !('steps' in input)) return false;
  const steps = (input as { steps?: unknown }).steps;
  return Array.isArray(steps)
    && steps.length > 0
    && steps.every(step => {
      if (typeof step !== 'object' || step === null || !('action' in step)) return false;
      const action = (step as { action?: unknown }).action;
      return action === 'read_clipboard' || action === 'wait';
    });
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function nearestExistingPath(candidate: string): Promise<{
  lexicalPath: string;
  canonicalPath: string;
}> {
  let current = candidate;
  while (true) {
    try {
      return {
        lexicalPath: current,
        canonicalPath: await realpath(current),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function resolveScreenshotOutputPath(
  workspaceDir: string,
  outputPath: string,
): Promise<string> {
  const workspacePath = path.resolve(workspaceDir);
  const candidate = path.resolve(workspacePath, outputPath);
  if (candidate === workspacePath || !isPathInside(workspacePath, candidate)) {
    throw new Error(`Computer screenshot output must stay inside the workspace: ${workspacePath}`);
  }

  const canonicalWorkspace = await realpath(workspacePath);
  const ancestor = await nearestExistingPath(candidate);
  if (!isPathInside(canonicalWorkspace, ancestor.canonicalPath)) {
    throw new Error(`Computer screenshot output must stay inside the workspace: ${canonicalWorkspace}`);
  }
  const resolved = path.resolve(
    ancestor.canonicalPath,
    path.relative(ancestor.lexicalPath, candidate),
  );
  if (!isPathInside(canonicalWorkspace, resolved)) {
    throw new Error(`Computer screenshot output must stay inside the workspace: ${canonicalWorkspace}`);
  }
  return resolved;
}

async function executeWorkflowStep(
  executor: ActoviqComputerUseExecutor,
  step: ActoviqComputerWorkflowStep,
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signalAborted(signal);
  switch (step.action) {
    case 'open_url':
      await runAbortable((signal) => executor.openUrl(step.url, signal), signal);
      return { action: step.action, url: step.url, ok: true };
    case 'type_text':
      await runAbortable((signal) => executor.typeText(step.text, signal), signal);
      return { action: step.action, text: step.text, ok: true };
    case 'focus_window':
      if (!executor.focusWindow) {
        throw new Error('The current computer-use executor does not support focus_window.');
      }
      await runAbortable((signal) => executor.focusWindow!(step.title, signal), signal);
      return { action: step.action, title: step.title, ok: true };
    case 'keypress':
      await runAbortable((signal) => executor.keyPress(step.keys, signal), signal);
      return { action: step.action, keys: step.keys, ok: true };
    case 'read_clipboard': {
      const text = await runAbortable((signal) => executor.readClipboard(signal), signal);
      return { action: step.action, text };
    }
    case 'write_clipboard':
      await runAbortable((signal) => executor.writeClipboard(step.text, signal), signal);
      return { action: step.action, ok: true };
    case 'take_screenshot': {
      const outputPath = await resolveScreenshotOutputPath(workspaceDir, step.outputPath);
      const savedTo = await runAbortable(
        (signal) => executor.takeScreenshot(outputPath, signal),
        signal,
      );
      return { action: step.action, savedTo };
    }
    case 'wait':
      await abortableDelay(step.durationMs, signal);
      return { action: step.action, durationMs: step.durationMs, ok: true };
  }
}

export function createActoviqComputerUseTools(
  options: CreateActoviqComputerUseOptions = {},
): AgentToolDefinition[] {
  const executor = options.executor ?? createDefaultActoviqComputerUseExecutor();
  const tools: AgentToolDefinition[] = [
    tool(
      {
        name: withPrefix(options.prefix, 'open_url'),
        description: 'Open a URL in the system browser.',
        inputSchema: z.object({ url: z.string().url() }),
        ...hostMutationMetadata,
      },
      async ({ url }, context) => {
        await runAbortable((signal) => executor.openUrl(url, signal), context.signal);
        return { ok: true, url };
      },
    ),
  ];

  if (executor.focusWindow) {
    tools.push(
      tool(
        {
          name: withPrefix(options.prefix, 'focus_window'),
          description: 'Focus a window by title before continuing the workflow.',
          inputSchema: z.object({ title: z.string().min(1) }),
          ...hostMutationMetadata,
        },
        async ({ title }, context) => {
          await runAbortable((signal) => executor.focusWindow!(title, signal), context.signal);
          return { ok: true, title };
        },
      ),
    );
  }

  tools.push(
    tool(
      {
        name: withPrefix(options.prefix, 'type_text'),
        description: 'Type text into the active application.',
        inputSchema: z.object({ text: z.string().min(1) }),
        ...hostMutationMetadata,
      },
      async ({ text }, context) => {
        await runAbortable((signal) => executor.typeText(text, signal), context.signal);
        return { ok: true, text };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'keypress'),
        description: 'Send keypresses to the active application.',
        inputSchema: z.object({ keys: z.array(z.string().min(1)).min(1) }),
        ...hostMutationMetadata,
      },
      async ({ keys }, context) => {
        await runAbortable((signal) => executor.keyPress(keys, signal), context.signal);
        return { ok: true, keys };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'read_clipboard'),
        description: 'Read the current clipboard text.',
        inputSchema: z.object({}),
        ...hostReadMetadata,
      },
      async (_input, context) => {
        const text = await runAbortable((signal) => executor.readClipboard(signal), context.signal);
        return { text };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'write_clipboard'),
        description: 'Write text to the clipboard.',
        inputSchema: z.object({ text: z.string() }),
        ...hostMutationMetadata,
      },
      async ({ text }, context) => {
        await runAbortable((signal) => executor.writeClipboard(text, signal), context.signal);
        return { ok: true };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'take_screenshot'),
        description: 'Capture a screenshot and save it to a path.',
        inputSchema: z.object({ outputPath: z.string().min(1) }),
        ...hostMutationMetadata,
      },
      async ({ outputPath }, context) => {
        signalAborted(context.signal);
        const resolved = await resolveScreenshotOutputPath(context.cwd, outputPath);
        const savedTo = await runAbortable(
          (signal) => executor.takeScreenshot(resolved, signal),
          context.signal,
        );
        return { savedTo };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'wait'),
        description: 'Wait for a short duration before continuing the workflow.',
        inputSchema: z.object({
          durationMs: z.number().int().min(1).max(60_000),
        }),
        ...passiveMetadata,
      },
      async ({ durationMs }, context) => {
        await abortableDelay(durationMs, context.signal);
        return { ok: true, durationMs };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'run_workflow'),
        description:
          'Run a small multi-step computer-use workflow sequentially, combining browser, keyboard, clipboard, screenshot, and wait actions.',
        inputSchema: z.object({
          steps: z.array(workflowStepSchema).min(1).max(50),
        }),
        isReadOnly: input => isReadOnlyWorkflow(input),
        isDestructive: input => !isReadOnlyWorkflow(input),
        requiresUserInteraction: () => true,
      },
      async ({ steps }, context) => {
        const results: Array<Record<string, unknown>> = [];
        for (const step of steps) {
          signalAborted(context.signal);
          results.push(
            await executeWorkflowStep(executor, step, context.cwd, context.signal),
          );
        }
        return {
          ok: true,
          stepCount: steps.length,
          results,
        };
      },
    ),
  );

  return tools;
}

export function createActoviqComputerUseMcpServer(
  options: CreateActoviqComputerUseOptions = {},
): LocalMcpServerDefinition {
  return {
    kind: 'local',
    name: options.serverName ?? 'actoviq-computer-use',
    prefix: options.prefix ?? 'computer',
    tools: createActoviqComputerUseTools(options),
  };
}

export function createActoviqComputerUseToolkit(
  options: CreateActoviqComputerUseOptions = {},
): ActoviqComputerUseToolkit {
  return {
    tools: createActoviqComputerUseTools(options),
    mcpServer: createActoviqComputerUseMcpServer(options),
  };
}
