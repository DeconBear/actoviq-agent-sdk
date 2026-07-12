import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type {
  AgentToolDefinition,
  CreateActoviqBrowserUseOptions,
  LocalMcpServerDefinition,
} from '../types.js';
import {
  ActoviqBrowserSession,
  type ActoviqBrowserSessionOptions,
} from './actoviqBrowserSession.js';

export interface ActoviqBrowserUseToolkit {
  tools: AgentToolDefinition[];
  mcpServer: LocalMcpServerDefinition;
  session: ActoviqBrowserSession;
}

export interface ActoviqBrowserSessionLike {
  navigate(url: string, opts?: { newTab?: boolean }): Promise<{ tabId: string; url: string; title: string }>;
  goBack(): Promise<{ url: string; title: string }>;
  wait(ms: number): Promise<void>;
  snapshot(opts?: { interactiveOnly?: boolean; maxElements?: number }): Promise<unknown>;
  click(target: { index?: number; x?: number; y?: number }): Promise<{ ok: true }>;
  type(input: { index: number; text: string; clear?: boolean; submit?: boolean }): Promise<{ ok: true }>;
  press(keys: string): Promise<{ ok: true }>;
  scroll(input: { direction: 'up' | 'down'; pages?: number; index?: number }): Promise<{ ok: true }>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<{ path?: string; base64?: string }>;
  tabsDetailed(): Promise<unknown>;
  switchTab(tabId: string): Promise<{ ok: true; tabId: string }>;
  closeTab(tabId?: string): Promise<{ ok: true; closed: string }>;
  extract(): Promise<{ url: string; title: string; text: string }>;
  evaluate?(expression: string): Promise<{ result: unknown }>;
  close(): Promise<void>;
}

function withPrefix(prefix: string | undefined, suffix: string): string {
  return prefix?.trim() ? `${prefix}_${suffix}` : `browser_${suffix}`;
}

export function sessionOptionsFromBrowserUse(
  options: CreateActoviqBrowserUseOptions = {},
): ActoviqBrowserSessionOptions {
  return {
    headless: options.headless,
    channel: options.channel,
    cdpUrl: options.cdpUrl,
    userDataDir: options.userDataDir,
    allowedDomains: options.allowedDomains,
    defaultTimeoutMs: options.defaultTimeoutMs,
    viewport: options.viewport,
  };
}

export function createActoviqBrowserTools(
  options: CreateActoviqBrowserUseOptions = {},
): AgentToolDefinition[] {
  const session: ActoviqBrowserSessionLike =
    options.session ?? new ActoviqBrowserSession(sessionOptionsFromBrowserUse(options));
  const allowEvaluate = options.allowEvaluate === true;

  const tools: AgentToolDefinition[] = [
    tool(
      {
        name: withPrefix(options.prefix, 'navigate'),
        description:
          'Open a URL in the controlled browser (Playwright). Prefer this for page automation; use computer_* for OS-level actions.',
        inputSchema: z.object({
          url: z.string().url(),
          newTab: z.boolean().optional(),
        }),
        isDestructive: () => false,
      },
      async ({ url, newTab }) => session.navigate(url, { newTab }),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'go_back'),
        description: 'Navigate the active browser tab back in history.',
        inputSchema: z.object({}),
      },
      async () => session.goBack(),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'wait'),
        description: 'Wait briefly for the page to settle before the next browser action.',
        inputSchema: z.object({
          ms: z.number().int().min(0).max(60_000).optional(),
        }),
      },
      async ({ ms }) => {
        await session.wait(ms ?? 1000);
        return { ok: true, ms: ms ?? 1000 };
      },
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'snapshot'),
        description:
          'Capture the current page URL/title and a numbered list of interactive elements. Use element indexes with browser_click / browser_type (browser-use style).',
        inputSchema: z.object({
          interactiveOnly: z.boolean().optional(),
          maxElements: z.number().int().min(1).max(300).optional(),
        }),
        isReadOnly: () => true,
      },
      async (input) => session.snapshot(input),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'click'),
        description: 'Click an interactive element by snapshot index, or by viewport x/y coordinates.',
        inputSchema: z.object({
          index: z.number().int().min(0).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        }),
      },
      async (input) => session.click(input),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'type'),
        description: 'Type into an interactive element identified by browser_snapshot index.',
        inputSchema: z.object({
          index: z.number().int().min(0),
          text: z.string(),
          clear: z.boolean().optional(),
          submit: z.boolean().optional(),
        }),
      },
      async (input) => session.type(input),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'press'),
        description: 'Press a key or chord in the active page (Playwright key names, e.g. Enter, Control+a).',
        inputSchema: z.object({
          keys: z.string().min(1),
        }),
      },
      async ({ keys }) => session.press(keys),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'scroll'),
        description: 'Scroll the page, or scroll a snapshot element into view.',
        inputSchema: z.object({
          direction: z.enum(['up', 'down']).optional(),
          pages: z.number().int().min(1).max(10).optional(),
          index: z.number().int().min(0).optional(),
        }),
      },
      async (input) =>
        session.scroll({
          direction: input.direction ?? 'down',
          pages: input.pages,
          index: input.index,
        }),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'screenshot'),
        description: 'Capture a PNG screenshot of the active tab. Provide path to save on disk, otherwise returns base64.',
        inputSchema: z.object({
          path: z.string().min(1).optional(),
          fullPage: z.boolean().optional(),
        }),
        isReadOnly: () => true,
      },
      async (input) => session.screenshot(input),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'tabs'),
        description: 'List open browser tabs (id, url, title, active).',
        inputSchema: z.object({}),
        isReadOnly: () => true,
      },
      async () => ({ tabs: await session.tabsDetailed() }),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'switch'),
        description: 'Switch the active browser tab by id from browser_tabs.',
        inputSchema: z.object({
          tabId: z.string().min(1),
        }),
      },
      async ({ tabId }) => session.switchTab(tabId),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'close'),
        description: 'Close a browser tab (defaults to the active tab). Closing the last tab opens a blank one.',
        inputSchema: z.object({
          tabId: z.string().min(1).optional(),
        }),
      },
      async ({ tabId }) => session.closeTab(tabId),
    ),
    tool(
      {
        name: withPrefix(options.prefix, 'extract'),
        description: 'Extract visible text from the active page (truncated). Prefer snapshot for interactive control.',
        inputSchema: z.object({}),
        isReadOnly: () => true,
      },
      async () => session.extract(),
    ),
  ];

  if (allowEvaluate && session.evaluate) {
    tools.push(
      tool(
        {
          name: withPrefix(options.prefix, 'evaluate'),
          description:
            'Evaluate a JavaScript expression in the page. Potentially dangerous; only enabled when allowEvaluate is true.',
          inputSchema: z.object({
            expression: z.string().min(1),
          }),
          isDestructive: () => true,
        },
        async ({ expression }) => session.evaluate!(expression),
      ),
    );
  }

  return tools;
}

export function createActoviqBrowserUseMcpServer(
  options: CreateActoviqBrowserUseOptions = {},
): LocalMcpServerDefinition {
  return {
    kind: 'local',
    name: options.serverName ?? 'actoviq-browser-use',
    prefix: options.prefix ?? 'browser',
    tools: createActoviqBrowserTools(options),
  };
}

export function createActoviqBrowserUseToolkit(
  options: CreateActoviqBrowserUseOptions = {},
): ActoviqBrowserUseToolkit {
  const session =
    (options.session as ActoviqBrowserSession | undefined) ??
    new ActoviqBrowserSession(sessionOptionsFromBrowserUse(options));
  const next: CreateActoviqBrowserUseOptions = { ...options, session };
  return {
    tools: createActoviqBrowserTools(next),
    mcpServer: createActoviqBrowserUseMcpServer(next),
    session,
  };
}
