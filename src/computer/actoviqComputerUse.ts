import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type {
  ActoviqComputerUseExecutor,
  AgentToolDefinition,
  CreateActoviqComputerUseOptions,
  LocalMcpServerDefinition,
} from '../types.js';

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

async function runPowerShell(command: string): Promise<string> {
  ensureWindows();
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export function createDefaultActoviqComputerUseExecutor(): ActoviqComputerUseExecutor {
  return {
    openUrl: (url) =>
      runPowerShell(`Start-Process '${url.replace(/'/g, "''")}'`).then(() => undefined),
    focusWindow: (title) =>
      runPowerShell(
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('${title.replace(/'/g, "''")}')`,
      ).then(() => undefined),
    typeText: (text) =>
      runPowerShell(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text.replace(/[{}+^%~()]/g, '{$&}').replace(/'/g, "''")}')`,
      ).then(() => undefined),
    keyPress: (keys) =>
      runPowerShell(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.join('+').replace(/'/g, "''")}')`,
      ).then(() => undefined),
    readClipboard: () => runPowerShell('Get-Clipboard -Raw'),
    writeClipboard: (text) =>
      runPowerShell(`Set-Clipboard -Value @'\n${text}\n'@`).then(() => undefined),
    takeScreenshot: async (outputPath) => {
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

async function executeWorkflowStep(
  executor: ActoviqComputerUseExecutor,
  step: ActoviqComputerWorkflowStep,
): Promise<Record<string, unknown>> {
  switch (step.action) {
    case 'open_url':
      await executor.openUrl(step.url);
      return { action: step.action, url: step.url, ok: true };
    case 'type_text':
      await executor.typeText(step.text);
      return { action: step.action, text: step.text, ok: true };
    case 'focus_window':
      if (!executor.focusWindow) {
        throw new Error('The current computer-use executor does not support focus_window.');
      }
      await executor.focusWindow(step.title);
      return { action: step.action, title: step.title, ok: true };
    case 'keypress':
      await executor.keyPress(step.keys);
      return { action: step.action, keys: step.keys, ok: true };
    case 'read_clipboard': {
      const text = await executor.readClipboard();
      return { action: step.action, text };
    }
    case 'write_clipboard':
      await executor.writeClipboard(step.text);
      return { action: step.action, ok: true };
    case 'take_screenshot': {
      const savedTo = await executor.takeScreenshot(step.outputPath);
      return { action: step.action, savedTo };
    }
    case 'wait':
      await new Promise(resolve => setTimeout(resolve, step.durationMs));
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
      },
      async ({ url }) => {
        await executor.openUrl(url);
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
        },
        async ({ title }) => {
          await executor.focusWindow?.(title);
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
      },
      async ({ text }) => {
        await executor.typeText(text);
        return { ok: true, text };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'keypress'),
        description: 'Send keypresses to the active application.',
        inputSchema: z.object({ keys: z.array(z.string().min(1)).min(1) }),
      },
      async ({ keys }) => {
        await executor.keyPress(keys);
        return { ok: true, keys };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'read_clipboard'),
        description: 'Read the current clipboard text.',
        inputSchema: z.object({}),
      },
      async () => {
        const text = await executor.readClipboard();
        return { text };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'write_clipboard'),
        description: 'Write text to the clipboard.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => {
        await executor.writeClipboard(text);
        return { ok: true };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'take_screenshot'),
        description: 'Capture a screenshot and save it to a path.',
        inputSchema: z.object({ outputPath: z.string().min(1) }),
      },
      async ({ outputPath }) => {
        const savedTo = await executor.takeScreenshot(outputPath);
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
      },
      async ({ durationMs }) => {
        await new Promise(resolve => setTimeout(resolve, durationMs));
        return { ok: true, durationMs };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'run_workflow'),
        description:
          'Run a small multi-step computer-use workflow sequentially, combining browser, keyboard, clipboard, screenshot, and wait actions.',
        inputSchema: z.object({
          steps: z.array(workflowStepSchema).min(1),
        }),
      },
      async ({ steps }) => {
        const results: Array<Record<string, unknown>> = [];
        for (const step of steps) {
          results.push(await executeWorkflowStep(executor, step));
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
