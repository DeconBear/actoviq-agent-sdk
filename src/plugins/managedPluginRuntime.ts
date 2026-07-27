import { realpathSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import { z } from 'zod';

import { resolveBrowserScreenshotPath } from '../browser/actoviqBrowserSession.js';
import { createActoviqBrowserUseToolkit } from '../browser/actoviqBrowserTools.js';
import { createActoviqComputerUseTools } from '../computer/actoviqComputerUse.js';
import { createE2bComputerUseToolkit } from '../computer/e2bComputerUse.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { createGitHubPlugin, type GitHubApiField } from './githubPlugin.js';
import {
  KIMI_WEBBRIDGE_ALLOWED_ACTIONS,
  createKimiWebBridgePlugin,
  type KimiWebBridgeAction,
} from './kimiWebBridgePlugin.js';
import {
  readStoredManagedPluginConfig,
  type ManagedPluginId,
} from './managedPluginCatalog.js';
import {
  createManagedOcrTool,
  type ManagedOcrApi,
  type ManagedOcrProvider,
} from './ocrPlugin.js';
import {
  buildImageGenConfigFromStored,
  createImageGenTool,
} from './imageGenPlugin.js';
import {
  buildVideoGenConfigFromStored,
  createVideoGenTool,
} from './videoGenPlugin.js';
import {
  buildMeshGenConfigFromStored,
  createMeshGenTool,
} from './meshGenPlugin.js';
import { createExaSearchTool } from '../tools/exaSearch.js';
import { createTavilySearchTool } from '../tools/tavilySearch.js';
import { hasMediaGenSecret } from './mediaGenProfiles.js';

export interface ManagedPluginRuntimeOptions {
  cwd: string;
}

export interface ManagedPluginRuntime {
  tools: AgentToolDefinition[];
  enabledPluginIds: ManagedPluginId[];
  close(): Promise<void>;
}

const githubFieldSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const readOnlyKimiActions = new Set<KimiWebBridgeAction>([
  'find_tab',
  'snapshot',
  'screenshot',
  'list_tabs',
]);

export function createManagedPluginRuntime(
  raw: Record<string, unknown>,
  options: ManagedPluginRuntimeOptions,
): ManagedPluginRuntime {
  const tools: AgentToolDefinition[] = [];
  const enabledPluginIds: ManagedPluginId[] = [];
  const closers: Array<() => Promise<void>> = [];

  const ocr = readStoredManagedPluginConfig(raw, 'ocr');
  if (ocr.enabled === true && stringValue(ocr.apiKey)) {
    enabledPluginIds.push('ocr');
    tools.push(createManagedOcrTool({
      provider: stringValue(ocr.provider) as ManagedOcrProvider,
      api: stringValue(ocr.api) as ManagedOcrApi,
      apiKey: stringValue(ocr.apiKey),
      baseURL: stringValue(ocr.baseURL),
      model: stringValue(ocr.model),
      prompt: stringValue(ocr.prompt),
      timeoutMs: numberValue(ocr.timeoutMs),
    }, {
      cwd: options.cwd,
      name: 'ocr_extract',
    }));
  }

  const computer = readStoredManagedPluginConfig(raw, 'computer-use');
  if (computer.enabled === true) {
    const backend = stringValue(computer.backend) || 'local';
    if (backend === 'e2b' && stringValue(computer.e2bApiKey)) {
      const width = numberValue(computer.resolutionWidth) ?? 1440;
      const height = numberValue(computer.resolutionHeight) ?? 900;
      const runtime = createE2bComputerUseToolkit({
        apiKey: stringValue(computer.e2bApiKey),
        template: stringValue(computer.e2bTemplate),
        resolution: [width, height],
        dpi: numberValue(computer.dpi),
        timeoutMs: numberValue(computer.timeoutMs),
      });
      enabledPluginIds.push('computer-use');
      tools.push(...runtime.tools);
      closers.push(runtime.close);
    } else if (backend === 'local') {
      enabledPluginIds.push('computer-use');
      tools.push(...createActoviqComputerUseTools());
    }
  }

  const github = readStoredManagedPluginConfig(raw, 'github');
  if (github.enabled === true) {
    const plugin = createGitHubPlugin({
      cwd: options.cwd,
      host: stringValue(github.hostname),
      token: stringValue(github.token),
      timeoutMs: numberValue(github.timeoutMs),
    });
    enabledPluginIds.push('github');
    tools.push(...createGitHubAgentTools(plugin));
  }

  const kimi = readStoredManagedPluginConfig(raw, 'kimi-webbridge');
  if (kimi.enabled === true) {
    const plugin = createKimiWebBridgePlugin({
      endpoint: kimiCommandEndpoint(stringValue(kimi.daemonUrl)),
      session: stringValue(kimi.sessionName),
      timeoutMs: numberValue(kimi.timeoutMs),
      autoStart: kimi.autoStart !== false,
    });
    enabledPluginIds.push('kimi-webbridge');
    tools.push(createKimiAgentTool(plugin));
  }

  const playwright = readStoredManagedPluginConfig(raw, 'playwright');
  if (playwright.enabled === true) {
    const runtime = createActoviqBrowserUseToolkit({
      headless: playwright.headless !== false,
      channel: browserChannel(playwright.channel),
      cdpUrl: stringValue(playwright.cdpUrl),
      userDataDir: stringValue(playwright.userDataDir),
      workspaceDir: options.cwd,
      allowedDomains: stringArray(playwright.allowedDomains),
      defaultTimeoutMs: numberValue(playwright.defaultTimeoutMs),
      allowEvaluate: playwright.allowEvaluate === true,
    });
    enabledPluginIds.push('playwright');
    tools.push(...runtime.tools);
    closers.push(() => runtime.session.close());
  }

  const tavily = readStoredManagedPluginConfig(raw, 'tavily');
  if (tavily.enabled === true && searchCredentialAvailable('tavily', stringValue(tavily.apiKey))) {
    enabledPluginIds.push('tavily');
    tools.push(createTavilySearchTool({
      apiKey: stringValue(tavily.apiKey) || undefined,
      timeoutMs: numberValue(tavily.timeoutMs),
    }));
  }

  const exa = readStoredManagedPluginConfig(raw, 'exa');
  if (exa.enabled === true && searchCredentialAvailable('exa', stringValue(exa.apiKey))) {
    enabledPluginIds.push('exa');
    tools.push(createExaSearchTool({
      apiKey: stringValue(exa.apiKey) || undefined,
      timeoutMs: numberValue(exa.timeoutMs),
    }));
  }

  const imageGen = readStoredManagedPluginConfig(raw, 'image-gen');
  if (imageGen.enabled === true && hasMediaGenSecret(imageGen, 'image')) {
    enabledPluginIds.push('image-gen');
    tools.push(createImageGenTool({
      cwd: options.cwd,
      config: buildImageGenConfigFromStored(imageGen),
      name: 'generate_image',
    }));
  }

  const videoGen = readStoredManagedPluginConfig(raw, 'video-gen');
  if (videoGen.enabled === true && hasMediaGenSecret(videoGen, 'video')) {
    enabledPluginIds.push('video-gen');
    tools.push(createVideoGenTool({
      cwd: options.cwd,
      config: buildVideoGenConfigFromStored(videoGen),
      name: 'generate_video',
    }));
  }

  const meshGen = readStoredManagedPluginConfig(raw, 'mesh-gen');
  if (meshGen.enabled === true && hasMediaGenSecret(meshGen, 'mesh')) {
    enabledPluginIds.push('mesh-gen');
    tools.push(createMeshGenTool({
      cwd: options.cwd,
      config: buildMeshGenConfigFromStored(meshGen),
      name: 'generate_mesh',
    }));
  }

  return {
    tools,
    enabledPluginIds,
    close: async () => {
      const errors: unknown[] = [];
      for (const close of closers.reverse()) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more managed plugin runtimes failed to close.');
      }
    },
  };
}

function createGitHubAgentTools(
  plugin: ReturnType<typeof createGitHubPlugin>,
): AgentToolDefinition[] {
  return [
    tool(
      {
        name: 'github_status',
        description:
          'Check whether GitHub CLI is installed and authenticated. Reuses the stored gh login unless this plugin has an alternate token.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => plugin.status(),
    ),
    tool(
      {
        name: 'github_read_api',
        description: 'Read a GitHub REST API endpoint through the authenticated GitHub CLI.',
        inputSchema: z.strictObject({
          endpoint: z.string().min(1),
          query: z.record(z.string(), githubFieldSchema).optional(),
        }),
        isReadOnly: () => true,
      },
      async ({ endpoint, query }) => plugin.readApi(
        endpoint,
        query as Record<string, GitHubApiField> | undefined,
      ),
    ),
    tool(
      {
        name: 'github_write_api',
        description:
          'Create or update GitHub data through the authenticated GitHub CLI. This is a remote write and requires approval.',
        inputSchema: z.strictObject({
          endpoint: z.string().min(1),
          method: z.enum(['POST', 'PATCH', 'PUT']),
          fields: z.record(z.string(), githubFieldSchema).optional(),
        }),
        isDestructive: () => true,
        requiresUserInteraction: () => true,
      },
      async ({ endpoint, method, fields }) => plugin.writeApi({
        endpoint,
        method,
        fields: fields as Record<string, GitHubApiField> | undefined,
      }),
    ),
    tool(
      {
        name: 'github_delete_api',
        description:
          'Delete data through a GitHub REST API endpoint. This is a destructive remote action and requires approval.',
        inputSchema: z.strictObject({ endpoint: z.string().min(1) }),
        isDestructive: () => true,
        requiresUserInteraction: () => true,
      },
      async ({ endpoint }) => plugin.deleteApi(endpoint),
    ),
  ];
}

function createKimiAgentTool(
  plugin: ReturnType<typeof createKimiWebBridgePlugin>,
): AgentToolDefinition {
  return tool(
    {
      name: 'kimi_webbridge',
      description:
        'Control the user’s existing signed-in Chrome or Edge browser through the local Kimi WebBridge daemon. Use snapshot refs for reliable interaction.',
      inputSchema: z.strictObject({
        action: z.enum(KIMI_WEBBRIDGE_ALLOWED_ACTIONS),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
      isReadOnly: input =>
        Boolean(
          input
          && readOnlyKimiActions.has(input.action)
          && !kimiActionWritesFile(input.action, input.args),
        ),
      isDestructive: input =>
        Boolean(
          input
          && (
            !readOnlyKimiActions.has(input.action)
            || kimiActionWritesFile(input.action, input.args)
          ),
        ),
      requiresUserInteraction: () => true,
      interruptBehavior: 'cancel',
    },
    async ({ action, args }, context) =>
      plugin.command(action, prepareKimiCommandArgs(action, args, context.cwd)),
  );
}

function kimiActionWritesFile(
  action: KimiWebBridgeAction,
  args: Record<string, unknown> | undefined,
): boolean {
  if (action === 'save_as_pdf' || action === 'upload') return true;
  return action === 'screenshot'
    && Boolean(
      typeof args?.path === 'string'
      || typeof args?.outputPath === 'string',
    );
}

export function prepareKimiCommandArgs(
  action: KimiWebBridgeAction,
  args: Record<string, unknown> | undefined,
  workspaceDir: string,
): Record<string, unknown> {
  const next = { ...(args ?? {}) };
  if (action === 'screenshot' || action === 'save_as_pdf') {
    let foundOutputPath = false;
    const outputFields = new Set(['path', 'outputPath', 'filePath', 'filename']);
    for (const [field, value] of Object.entries(next)) {
      if (/path|file(?:name)?/iu.test(field) && !outputFields.has(field)) {
        throw new TypeError(`Unsupported Kimi WebBridge output path field: ${field}`);
      }
      if (!outputFields.has(field)) continue;
      if (!Object.hasOwn(next, field)) continue;
      if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`Kimi WebBridge ${field} must be a non-empty string.`);
      }
      next[field] = resolveBrowserScreenshotPath(workspaceDir, value.trim());
      foundOutputPath = true;
    }
    if (action === 'save_as_pdf' && !foundOutputPath) {
      throw new TypeError('Kimi WebBridge save_as_pdf requires a workspace output path.');
    }
  }
  if (action === 'upload') {
    let foundInput = false;
    const inputFields = new Set([
      'files',
      'paths',
      'file',
      'path',
      'filePath',
      'filePaths',
      'file_paths',
    ]);
    for (const [field, value] of Object.entries(next)) {
      if (/path|file/iu.test(field) && !inputFields.has(field)) {
        throw new TypeError(`Unsupported Kimi WebBridge upload path field: ${field}`);
      }
      if (!inputFields.has(field)) continue;
      if (typeof value === 'string') {
        next[field] = resolveKimiInputFile(workspaceDir, value);
        foundInput = true;
        continue;
      }
      if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
        next[field] = value.map(item => resolveKimiInputFile(workspaceDir, item));
        foundInput = true;
        continue;
      }
      throw new TypeError(`Kimi WebBridge upload ${field} must contain one or more file paths.`);
    }
    if (!foundInput) {
      throw new TypeError('Kimi WebBridge upload requires workspace file paths.');
    }
  }
  return next;
}

function resolveKimiInputFile(workspaceDir: string, requestedPath: string): string {
  const workspaceRoot = realpathSync.native(path.resolve(workspaceDir));
  const candidate = path.resolve(workspaceRoot, requestedPath.trim());
  if (!isPathInside(workspaceRoot, candidate)) {
    throw new Error(`Kimi WebBridge upload path must stay inside the workspace: ${requestedPath}`);
  }
  const canonical = realpathSync.native(candidate);
  if (!isPathInside(workspaceRoot, canonical) || !statSync(canonical).isFile()) {
    throw new Error(`Kimi WebBridge upload path must identify a workspace file: ${requestedPath}`);
  }
  return canonical;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function kimiCommandEndpoint(value: string): string {
  const base = value || 'http://127.0.0.1:10086';
  return /\/command\/?$/u.test(base)
    ? base.replace(/\/$/u, '')
    : `${base.replace(/\/+$/u, '')}/command`;
}

function browserChannel(value: unknown): 'chromium' | 'chrome' | 'msedge' | undefined {
  return value === 'chromium' || value === 'chrome' || value === 'msedge'
    ? value
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function searchCredentialAvailable(
  pluginId: 'tavily' | 'exa',
  configuredKey: string,
): boolean {
  if (configuredKey.trim()) return true;
  if (pluginId === 'tavily') {
    if (process.env.TAVILY_API_KEY?.trim()) return true;
    try {
      return existsSync(path.join(homedir(), '.tavily', 'config.json'));
    } catch {
      return false;
    }
  }
  if (process.env.EXA_API_KEY?.trim()) return true;
  try {
    return existsSync(path.join(homedir(), '.exa', 'config.json'));
  } catch {
    return false;
  }
}
