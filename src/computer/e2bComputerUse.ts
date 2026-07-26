import { realpath as realpathCallback } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { signalAborted } from '../runtime/helpers.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

const realpath = promisify(realpathCallback.native);

export interface E2bDesktopSandboxLike {
  sandboxId?: string;
  open(fileOrUrl: string): Promise<void>;
  leftClick(x?: number, y?: number): Promise<void>;
  doubleClick(x?: number, y?: number): Promise<void>;
  rightClick(x?: number, y?: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  scroll(direction?: 'up' | 'down', amount?: number): Promise<void>;
  write(text: string, options?: { chunkSize: number; delayInMs: number }): Promise<void>;
  press(key: string | string[]): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  wait(ms: number): Promise<void>;
  commands: {
    run(
      command: string,
      options?: { timeoutMs?: number },
    ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  };
  kill(options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<void>;
}

export interface E2bDesktopCreateOptions {
  apiKey: string;
  template?: string;
  resolution?: [number, number];
  dpi?: number;
  timeoutMs?: number;
}

interface E2bDesktopModule {
  Sandbox: {
    create(options?: Record<string, unknown>): Promise<E2bDesktopSandboxLike>;
    create(template: string, options?: Record<string, unknown>): Promise<E2bDesktopSandboxLike>;
  };
}

export interface CreateE2bComputerUseOptions extends E2bDesktopCreateOptions {
  prefix?: string;
  sandboxFactory?: (options: E2bDesktopCreateOptions) => Promise<E2bDesktopSandboxLike>;
  moduleLoader?: () => Promise<E2bDesktopModule>;
}

export interface E2bComputerUseToolkit {
  tools: AgentToolDefinition[];
  close(): Promise<void>;
  isStarted(): boolean;
}

function name(prefix: string | undefined, suffix: string): string {
  return `${prefix?.trim() || 'computer'}_${suffix}`;
}

async function defaultModuleLoader(): Promise<E2bDesktopModule> {
  const packageName = '@e2b/desktop';
  try {
    return await import(packageName) as E2bDesktopModule;
  } catch (error) {
    throw new Error(
      'The "@e2b/desktop" optional dependency is required for E2B Computer Use. ' +
      'Install the packaged optional dependencies or run npm install @e2b/desktop.',
      { cause: error },
    );
  }
}

async function defaultSandboxFactory(
  options: E2bDesktopCreateOptions,
  moduleLoader: () => Promise<E2bDesktopModule>,
): Promise<E2bDesktopSandboxLike> {
  let module: E2bDesktopModule;
  try {
    module = await moduleLoader();
  } catch (error) {
    if (error instanceof Error && error.message.includes('@e2b/desktop')) throw error;
    throw new Error(
      'The "@e2b/desktop" optional dependency is required for E2B Computer Use.',
      { cause: error },
    );
  }
  const createOptions = {
    apiKey: options.apiKey,
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(typeof options.dpi === 'number' ? { dpi: options.dpi } : {}),
    ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
  };
  return options.template?.trim()
    ? module.Sandbox.create(options.template.trim(), createOptions)
    : module.Sandbox.create(createOptions);
}

function coordinateSchema() {
  return z.strictObject({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  });
}

const E2B_CLEANUP_MAX_ATTEMPTS = 3;
const E2B_CLEANUP_ATTEMPT_TIMEOUT_MS = 10_000;
const E2B_CLEANUP_RETRY_DELAY_MS = 250;
const E2B_NOT_STARTED_MESSAGE =
  'E2B desktop sandbox is not started. Call computer_start first.';

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupRetryDelay(attempt: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, E2B_CLEANUP_RETRY_DELAY_MS * attempt);
  });
}

async function runAbortable<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signalAborted(signal);
  if (!signal) return operation();

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
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function screenshotWorkspaceError(workspaceDir: string): Error {
  return new Error(
    `E2B screenshot output must stay inside the workspace: ${workspaceDir}`,
  );
}

async function resolveScreenshotOutputPath(
  workspaceDir: string,
  outputPath: string,
): Promise<string> {
  const workspacePath = path.resolve(workspaceDir);
  const candidate = path.isAbsolute(outputPath)
    ? path.resolve(outputPath)
    : path.resolve(workspacePath, outputPath);
  if (!isPathInside(workspacePath, candidate)) {
    throw screenshotWorkspaceError(workspacePath);
  }

  const canonicalWorkspace = await realpath(workspacePath);
  try {
    const canonicalCandidate = await realpath(candidate);
    if (!isPathInside(canonicalWorkspace, canonicalCandidate)) {
      throw screenshotWorkspaceError(canonicalWorkspace);
    }
    return canonicalCandidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const canonicalParent = await realpath(path.dirname(candidate));
  if (!isPathInside(canonicalWorkspace, canonicalParent)) {
    throw screenshotWorkspaceError(canonicalWorkspace);
  }
  return path.join(canonicalParent, path.basename(candidate));
}

export function createE2bComputerUseToolkit(
  options: CreateE2bComputerUseOptions,
): E2bComputerUseToolkit {
  let sandbox: E2bDesktopSandboxLike | null = null;
  let pending: Promise<E2bDesktopSandboxLike> | null = null;
  let closing: Promise<void> | null = null;
  const moduleLoader = options.moduleLoader ?? defaultModuleLoader;

  const createOptions: E2bDesktopCreateOptions = {
    apiKey: options.apiKey,
    template: options.template,
    resolution: options.resolution,
    dpi: options.dpi,
    timeoutMs: options.timeoutMs,
  };

  const startSandbox = async (): Promise<E2bDesktopSandboxLike> => {
    if (closing) await closing;
    if (!options.apiKey.trim()) {
      throw new Error('An E2B API key is required before a desktop sandbox can be created.');
    }
    if (sandbox) return sandbox;
    if (!pending) {
      let creation!: Promise<E2bDesktopSandboxLike>;
      creation = (options.sandboxFactory
        ? options.sandboxFactory(createOptions)
        : defaultSandboxFactory(createOptions, moduleLoader))
        .then(created => {
          sandbox = created;
          return created;
        })
        .finally(() => {
          if (pending === creation) pending = null;
        });
      pending = creation;
    }
    return pending;
  };

  const requireStartedSandbox = async (): Promise<E2bDesktopSandboxLike> => {
    if (closing) {
      throw new Error('E2B desktop sandbox cleanup is in progress. Wait and try again.');
    }
    if (sandbox) return sandbox;
    if (pending) return pending;
    throw new Error(E2B_NOT_STARTED_MESSAGE);
  };

  const closeCurrentSandbox = async (): Promise<void> => {
    let current = sandbox;
    if (!current && pending) {
      const creation = pending;
      try {
        current = await withTimeout(
          () => creation,
          E2B_CLEANUP_ATTEMPT_TIMEOUT_MS,
          'Timed out waiting for the E2B sandbox creation to finish before cleanup.',
        );
      } catch (error) {
        if (sandbox) {
          current = sandbox;
        } else if (pending !== creation) {
          return;
        } else {
          throw new Error(
            'Could not clean up the E2B sandbox because creation is still pending. ' +
            'The creation handle was retained; billing may continue if the sandbox becomes active.',
            { cause: error },
          );
        }
      }
    }
    if (!current) return;

    const errors: unknown[] = [];
    for (let attempt = 1; attempt <= E2B_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await withTimeout(
          signal => current.kill({
            requestTimeoutMs: E2B_CLEANUP_ATTEMPT_TIMEOUT_MS,
            signal,
          }),
          E2B_CLEANUP_ATTEMPT_TIMEOUT_MS,
          `E2B sandbox cleanup attempt ${attempt} timed out.`,
        );
        if (sandbox === current) sandbox = null;
        pending = null;
        return;
      } catch (error) {
        errors.push(error);
        if (attempt < E2B_CLEANUP_MAX_ATTEMPTS) {
          await cleanupRetryDelay(attempt);
        }
      }
    }

    throw new AggregateError(
      errors,
      `Failed to terminate the E2B sandbox after ${E2B_CLEANUP_MAX_ATTEMPTS} attempts. ` +
      'The sandbox handle was retained so cleanup can be retried; billing may continue ' +
      'until cleanup succeeds or the configured E2B sandbox timeout expires.',
    );
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    let operation!: Promise<void>;
    operation = closeCurrentSandbox().finally(() => {
      if (closing === operation) closing = null;
    });
    closing = operation;
    return operation;
  };

  const tools: AgentToolDefinition[] = [
    tool(
      {
        name: name(options.prefix, 'start'),
        description:
          'Start an isolated E2B Linux desktop sandbox. This may create a billable external resource and requires approval.',
        inputSchema: z.strictObject({}),
        isDestructive: () => true,
        requiresUserInteraction: () => true,
      },
      async () => {
        const current = await startSandbox();
        return { ok: true, backend: 'e2b', sandboxId: current.sandboxId ?? null };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'open_url'),
        description: 'Open a URL inside the isolated E2B desktop.',
        inputSchema: z.strictObject({ url: z.string().url() }),
        isDestructive: () => true,
      },
      async ({ url }) => {
        await (await requireStartedSandbox()).open(url);
        return { ok: true, url };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'click'),
        description: 'Left-click screen coordinates in the isolated E2B desktop.',
        inputSchema: coordinateSchema(),
        isDestructive: () => true,
      },
      async ({ x, y }) => {
        await (await requireStartedSandbox()).leftClick(x, y);
        return { ok: true, x, y };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'double_click'),
        description: 'Double-click screen coordinates in the isolated E2B desktop.',
        inputSchema: coordinateSchema(),
        isDestructive: () => true,
      },
      async ({ x, y }) => {
        await (await requireStartedSandbox()).doubleClick(x, y);
        return { ok: true, x, y };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'right_click'),
        description: 'Right-click screen coordinates in the isolated E2B desktop.',
        inputSchema: coordinateSchema(),
        isDestructive: () => true,
      },
      async ({ x, y }) => {
        await (await requireStartedSandbox()).rightClick(x, y);
        return { ok: true, x, y };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'move_mouse'),
        description: 'Move the pointer to screen coordinates in the isolated E2B desktop.',
        inputSchema: coordinateSchema(),
        isDestructive: () => true,
      },
      async ({ x, y }) => {
        await (await requireStartedSandbox()).moveMouse(x, y);
        return { ok: true, x, y };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'drag'),
        description: 'Drag between two screen coordinates in the isolated E2B desktop.',
        inputSchema: z.strictObject({
          fromX: z.number().int().min(0),
          fromY: z.number().int().min(0),
          toX: z.number().int().min(0),
          toY: z.number().int().min(0),
        }),
        isDestructive: () => true,
      },
      async ({ fromX, fromY, toX, toY }) => {
        await (await requireStartedSandbox()).drag([fromX, fromY], [toX, toY]);
        return { ok: true, from: [fromX, fromY], to: [toX, toY] };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'scroll'),
        description: 'Scroll the isolated E2B desktop.',
        inputSchema: z.strictObject({
          direction: z.enum(['up', 'down']),
          amount: z.number().int().min(1).max(100).optional(),
        }),
        isDestructive: () => true,
      },
      async ({ direction, amount }) => {
        await (await requireStartedSandbox()).scroll(direction, amount ?? 3);
        return { ok: true, direction, amount: amount ?? 3 };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'type_text'),
        description: 'Type text into the focused application in the isolated E2B desktop.',
        inputSchema: z.strictObject({ text: z.string().min(1) }),
        isDestructive: () => true,
      },
      async ({ text }) => {
        await (await requireStartedSandbox()).write(text, { chunkSize: 50, delayInMs: 25 });
        return { ok: true, characterCount: text.length };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'keypress'),
        description: 'Press a key or key chord in the isolated E2B desktop.',
        inputSchema: z.strictObject({ keys: z.array(z.string().min(1)).min(1) }),
        isDestructive: () => true,
      },
      async ({ keys }) => {
        await (await requireStartedSandbox()).press(keys);
        return { ok: true, keys };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'take_screenshot'),
        description:
          'Capture the isolated E2B desktop. Returns base64 unless outputPath is provided; ' +
          'file output is restricted to the current workspace.',
        inputSchema: z.strictObject({ outputPath: z.string().min(1).optional() }),
        isReadOnly: input => !input?.outputPath,
        isDestructive: input => Boolean(input?.outputPath),
      },
      async ({ outputPath }, context) => {
        const bytes = await (await requireStartedSandbox()).screenshot();
        if (!outputPath) {
          return {
            base64: Buffer.from(bytes).toString('base64'),
            mimeType: 'image/png',
            sizeBytes: bytes.byteLength,
          };
        }
        const resolved = await resolveScreenshotOutputPath(context.cwd, outputPath);
        await writeFile(resolved, bytes);
        return { savedTo: resolved, sizeBytes: bytes.byteLength };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'run_command'),
        description: 'Run a shell command inside the isolated E2B sandbox.',
        inputSchema: z.strictObject({
          command: z.string().min(1),
          timeoutMs: z.number().int().min(1).max(600_000).optional(),
        }),
        isDestructive: () => true,
      },
      async ({ command, timeoutMs }, context) => {
        const current = await requireStartedSandbox();
        const result = await runAbortable(
          () => current.commands.run(command, { timeoutMs }),
          context.signal,
        );
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.exitCode ?? 0,
        };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'wait'),
        description: 'Wait briefly in the isolated E2B desktop session.',
        inputSchema: z.strictObject({
          durationMs: z.number().int().min(1).max(60_000),
        }),
        isReadOnly: () => true,
      },
      async ({ durationMs }, context) => {
        const current = await requireStartedSandbox();
        await runAbortable(() => current.wait(durationMs), context.signal);
        return { ok: true, durationMs };
      },
    ),
    tool(
      {
        name: name(options.prefix, 'stop'),
        description: 'Terminate the current E2B desktop sandbox and release the external resource.',
        inputSchema: z.strictObject({}),
        isDestructive: () => true,
        requiresUserInteraction: () => true,
      },
      async () => {
        await close();
        return { ok: true };
      },
    ),
  ];

  return {
    tools,
    close,
    isStarted: () => sandbox !== null,
  };
}
