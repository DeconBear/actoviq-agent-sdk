import {
  readStoredManagedPluginConfig,
  type ManagedPluginHealth,
  type ManagedPluginId,
} from './managedPluginCatalog.js';
import { createGitHubPlugin } from './githubPlugin.js';
import { createKimiWebBridgePlugin } from './kimiWebBridgePlugin.js';
import {
  availableMediaProfiles,
  hasMediaGenSecret,
  isMediaGenPluginId,
  kindForPluginId,
} from './mediaGenProfiles.js';
import { resolveExaApiKey, runExaSearch } from '../tools/exaSearch.js';
import { resolveTavilyApiKey, runTavilySearch } from '../tools/tavilySearch.js';

export interface ManagedPluginHealthOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  moduleLoader?: (specifier: string) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
}

export async function probeManagedPlugin(
  raw: Record<string, unknown>,
  pluginId: ManagedPluginId,
  options: ManagedPluginHealthOptions,
): Promise<ManagedPluginHealth> {
  const config = readStoredManagedPluginConfig(raw, pluginId);
  if (config.enabled !== true) {
    return { state: 'needs-setup', detail: 'Install and enable the plugin first.' };
  }

  if (pluginId === 'ocr') {
    if (!stringValue(config.apiKey)) {
      return { state: 'needs-setup', detail: 'Add an OCR provider API key.' };
    }
    return {
      state: 'ready',
      detail: `${stringValue(config.provider) || 'OCR'} configuration is valid. Run OCR on a sample file to verify provider access.`,
    };
  }

  if (pluginId === 'computer-use') {
    if (config.backend !== 'e2b') {
      return (options.platform ?? process.platform) === 'win32'
        ? { state: 'ready', detail: 'Local Windows computer control is available.' }
        : { state: 'degraded', detail: 'The local desktop backend currently requires Windows.' };
    }
    if (!stringValue(config.e2bApiKey)) {
      return { state: 'needs-setup', detail: 'Add an E2B API key.' };
    }
    try {
      await (options.moduleLoader ?? defaultModuleLoader)('@e2b/desktop');
      return {
        state: 'ready',
        detail: 'E2B Desktop SDK is installed. No billable sandbox was created by this check.',
      };
    } catch {
      return {
        state: 'degraded',
        detail: 'The optional @e2b/desktop package is not installed.',
      };
    }
  }

  if (pluginId === 'github') {
    const status = await createGitHubPlugin({
      cwd: options.cwd,
      host: stringValue(config.hostname),
      token: stringValue(config.token),
      timeoutMs: numberValue(config.timeoutMs),
    }).status();
    if (status.ok) return { state: 'ready', detail: status.message };
    return {
      state: status.state === 'not_authenticated' ? 'needs-setup' : 'degraded',
      detail: status.message,
    };
  }

  if (pluginId === 'kimi-webbridge') {
    const status = await createKimiWebBridgePlugin({
      endpoint: commandEndpoint(stringValue(config.daemonUrl)),
      session: stringValue(config.sessionName),
      timeoutMs: numberValue(config.timeoutMs),
      autoStart: config.autoStart !== false,
      fetch: options.fetch,
    }).testConnection();
    return status.ok
      ? { state: 'ready', detail: status.message }
      : { state: status.state === 'unavailable' ? 'needs-setup' : 'degraded', detail: status.message };
  }

  if (pluginId === 'tavily') {
    const apiKey = await resolveTavilyApiKey(stringValue(config.apiKey) || undefined);
    if (!apiKey) {
      return {
        state: 'needs-setup',
        detail: 'Add a Tavily API key, set TAVILY_API_KEY, or create ~/.tavily/config.json.',
      };
    }
    const result = await runTavilySearch({
      query: 'Hadamard connection check',
      depth: 'basic',
      topic: 'general',
      max_results: 1,
      include_answer: false,
      include_raw_content: false,
    }, {
      apiKey,
      timeoutMs: numberValue(config.timeoutMs) ?? 20_000,
    });
    if (result.startsWith('Error:') || result.startsWith('Tavily search failed:')) {
      return { state: 'degraded', detail: result.slice(0, 240) };
    }
    return { state: 'ready', detail: 'Tavily search responded successfully.' };
  }

  if (pluginId === 'exa') {
    const apiKey = await resolveExaApiKey(stringValue(config.apiKey) || undefined);
    if (!apiKey) {
      return {
        state: 'needs-setup',
        detail: 'Add an Exa API key, set EXA_API_KEY, or create ~/.exa/config.json.',
      };
    }
    const result = await runExaSearch({
      query: 'Hadamard connection check',
      type: 'fast',
      num_results: 1,
      include_text: false,
      include_highlights: true,
    }, {
      apiKey,
      timeoutMs: numberValue(config.timeoutMs) ?? 20_000,
    });
    if (result.startsWith('Error:') || result.startsWith('Exa search failed:')) {
      return { state: 'degraded', detail: result.slice(0, 240) };
    }
    return { state: 'ready', detail: 'Exa search responded successfully.' };
  }

  if (isMediaGenPluginId(pluginId)) {
    const kind = kindForPluginId(pluginId);
    if (!hasMediaGenSecret(config, kind)) {
      return {
        state: 'needs-setup',
        detail: `Add at least one ${kind} generation profile with an API key.`,
      };
    }
    const profiles = availableMediaProfiles(config, kind);
    const defaultId = stringValue(config.defaultProfileId);
    const preferred = defaultId
      ? profiles.find(profile => profile.id === defaultId) ?? profiles[0]
      : profiles[0];
    return {
      state: 'ready',
      detail:
        `${profiles.length} profile(s) configured`
        + (preferred
          ? `; default ${preferred.id} (${preferred.provider}/${preferred.model}). `
          : '. ')
        + 'Connection checks do not call billable generation APIs.',
    };
  }

  try {
    await (options.moduleLoader ?? defaultModuleLoader)('playwright');
    return {
      state: 'ready',
      detail: stringValue(config.cdpUrl)
        ? 'Playwright is installed and will attach through CDP.'
        : stringValue(config.userDataDir)
          ? 'Playwright is installed and will reuse the configured persistent profile.'
          : 'Playwright is installed and will use an isolated browser profile.',
    };
  } catch {
    return {
      state: 'degraded',
      detail: 'The optional Playwright package is not installed.',
    };
  }
}

async function defaultModuleLoader(specifier: string): Promise<unknown> {
  return import(specifier);
}

function commandEndpoint(value: string): string {
  const base = value || 'http://127.0.0.1:10086';
  return /\/command\/?$/u.test(base)
    ? base.replace(/\/$/u, '')
    : `${base.replace(/\/+$/u, '')}/command`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
