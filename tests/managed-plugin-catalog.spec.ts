import { describe, expect, it } from 'vitest';

import {
  MANAGED_PLUGIN_DEFINITIONS,
  patchManagedPluginSettings,
  readManagedPluginCatalog,
  readStoredManagedPluginConfig,
} from '../src/plugins/managedPluginCatalog.js';

describe('managed plugin catalog', () => {
  it('publishes the built-in plugins as available by default', () => {
    const catalog = readManagedPluginCatalog({});

    expect(MANAGED_PLUGIN_DEFINITIONS.map(plugin => plugin.id)).toEqual([
      'ocr',
      'computer-use',
      'github',
      'kimi-webbridge',
      'playwright',
      'tavily',
      'exa',
      'image-gen',
      'video-gen',
      'mesh-gen',
    ]);
    expect(catalog.plugins.map(plugin => plugin.id)).toEqual([
      'ocr',
      'computer-use',
      'github',
      'kimi-webbridge',
      'playwright',
      'tavily',
      'exa',
      'image-gen',
      'video-gen',
      'mesh-gen',
    ]);
    expect(catalog.plugins.every(plugin => plugin.state === 'available')).toBe(true);
  });

  it('stores OCR credentials server-side and never returns secret fields', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'ocr', {
      enabled: true,
      provider: 'qwen',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-vl-ocr',
      apiKey: 'qwen-secret',
    });

    const plugin = readManagedPluginCatalog(raw).plugins.find(item => item.id === 'ocr');
    expect(plugin).toMatchObject({
      enabled: true,
      state: 'ready',
      secretConfigured: true,
      config: {
        provider: 'qwen',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-vl-ocr',
      },
    });
    expect(plugin?.config).not.toHaveProperty('apiKey');
    expect(plugin?.config).not.toHaveProperty('token');
    expect(plugin?.config).not.toHaveProperty('e2bApiKey');
    expect(readStoredManagedPluginConfig(raw, 'ocr')).toMatchObject({
      enabled: true,
      apiKey: 'qwen-secret',
    });
  });

  it('keeps an existing secret for an empty password and clears it explicitly', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'ocr', {
      enabled: true,
      apiKey: 'keep-me',
    });

    patchManagedPluginSettings(raw, 'ocr', {
      apiKey: '   ',
      model: 'qwen-vl-max',
    });
    expect(readStoredManagedPluginConfig(raw, 'ocr')).toMatchObject({
      apiKey: 'keep-me',
      model: 'qwen-vl-max',
    });
    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'ocr')).toMatchObject({
      state: 'ready',
      secretConfigured: true,
    });

    patchManagedPluginSettings(raw, 'ocr', { clearSecret: true });
    expect(readStoredManagedPluginConfig(raw, 'ocr')).not.toHaveProperty('apiKey');
    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'ocr')).toMatchObject({
      state: 'needs-setup',
      secretConfigured: false,
    });
  });

  it('requires an E2B key only for the E2B computer-use backend', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'local',
    });
    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'computer-use')).toMatchObject({
      state: 'ready',
      secretConfigured: false,
      config: { backend: 'local' },
    });

    patchManagedPluginSettings(raw, 'computer-use', { backend: 'e2b' });
    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'computer-use')).toMatchObject({
      state: 'needs-setup',
      secretConfigured: false,
    });

    patchManagedPluginSettings(raw, 'computer-use', { e2bApiKey: 'e2b-secret' });
    const plugin = readManagedPluginCatalog(raw).plugins.find(item => item.id === 'computer-use');
    expect(plugin).toMatchObject({ state: 'ready', secretConfigured: true });
    expect(plugin?.config).not.toHaveProperty('e2bApiKey');
  });

  it('uses a configured GitHub token without exposing it', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'github', {
      enabled: true,
      token: 'github-secret',
      hostname: 'github.example.test',
    });

    const plugin = readManagedPluginCatalog(raw).plugins.find(item => item.id === 'github');
    expect(plugin).toMatchObject({
      state: 'ready',
      secretConfigured: true,
      config: { hostname: 'github.example.test' },
    });
    expect(plugin?.config).not.toHaveProperty('token');
  });

  it('maps legacy browser.enabled to Playwright and keeps it synchronized on patch', () => {
    const raw: Record<string, unknown> = {
      browser: {
        enabled: true,
        headless: false,
        channel: 'chrome',
      },
    };

    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'playwright')).toMatchObject({
      enabled: true,
      state: 'ready',
      config: {
        headless: false,
        channel: 'chrome',
      },
    });

    patchManagedPluginSettings(raw, 'playwright', {
      enabled: false,
      headless: true,
      channel: 'chromium',
    });
    expect(raw.browser).toMatchObject({
      enabled: false,
      headless: true,
      channel: 'chromium',
    });
    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'playwright')).toMatchObject({
      enabled: false,
      state: 'disabled',
    });
  });

  it('surfaces bounded health overrides as degraded status', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'kimi-webbridge', {
      enabled: true,
      daemonUrl: 'http://127.0.0.1:10086',
    });

    const plugin = readManagedPluginCatalog(raw, {
      health: {
        'kimi-webbridge': {
          state: 'degraded',
          detail: 'WebBridge daemon is not reachable.',
        },
      },
    }).plugins.find(item => item.id === 'kimi-webbridge');

    expect(plugin).toMatchObject({
      state: 'degraded',
      statusDetail: 'WebBridge daemon is not reachable.',
    });
  });

  it('treats Tavily/Exa as ready when an external key file or env is present', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'tavily', { enabled: true });
    patchManagedPluginSettings(raw, 'exa', { enabled: true, apiKey: 'exa-secret' });

    const catalog = readManagedPluginCatalog(raw);
    const tavily = catalog.plugins.find(item => item.id === 'tavily');
    const exa = catalog.plugins.find(item => item.id === 'exa');
    // Tavily may be ready via ~/.tavily/config.json even without a stored plugin key.
    expect(['ready', 'needs-setup']).toContain(tavily?.state);
    expect(exa).toMatchObject({
      enabled: true,
      state: 'ready',
      secretConfigured: true,
    });
    expect(exa?.config).not.toHaveProperty('apiKey');
  });

  it('stores per-profile media generation secrets without returning them', () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'image-gen', {
      enabled: true,
      defaultProfileId: 'nano-banana',
      profiles: [
        {
          id: 'nano-banana',
          provider: 'gemini',
          model: 'gemini-2.0-flash-preview-image-generation',
          apiKey: 'gem-secret',
        },
        {
          id: 'gpt-image',
          provider: 'openai',
          model: 'gpt-image-2',
          apiKey: 'oai-secret',
        },
      ],
    });

    const plugin = readManagedPluginCatalog(raw).plugins.find(item => item.id === 'image-gen');
    expect(plugin).toMatchObject({
      enabled: true,
      state: 'ready',
      secretConfigured: true,
      config: {
        defaultProfileId: 'nano-banana',
      },
    });
    expect(plugin?.config.profiles).toEqual([
      expect.objectContaining({
        id: 'nano-banana',
        provider: 'gemini',
        secretConfigured: true,
      }),
      expect.objectContaining({
        id: 'gpt-image',
        provider: 'openai',
        secretConfigured: true,
      }),
    ]);
    expect(JSON.stringify(plugin?.config)).not.toContain('gem-secret');
    expect(JSON.stringify(plugin?.config)).not.toContain('oai-secret');

    const stored = readStoredManagedPluginConfig(raw, 'image-gen');
    expect(stored.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nano-banana', apiKey: 'gem-secret' }),
      expect.objectContaining({ id: 'gpt-image', apiKey: 'oai-secret' }),
    ]));

    patchManagedPluginSettings(raw, 'image-gen', {
      profiles: [
        {
          id: 'nano-banana',
          provider: 'gemini',
          model: 'gemini-2.0-flash-preview-image-generation',
          apiKey: '',
        },
        {
          id: 'gpt-image',
          provider: 'openai',
          model: 'gpt-image-2',
          apiKey: 'oai-rotated',
        },
      ],
    });
    expect(readStoredManagedPluginConfig(raw, 'image-gen').profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nano-banana', apiKey: 'gem-secret' }),
      expect.objectContaining({ id: 'gpt-image', apiKey: 'oai-rotated' }),
    ]));

    patchManagedPluginSettings(raw, 'image-gen', { clearSecret: true });
    const cleared = readStoredManagedPluginConfig(raw, 'image-gen').profiles as Array<Record<string, unknown>>;
    expect(cleared.every(profile => !profile.apiKey)).toBe(true);
    expect(readManagedPluginCatalog(raw).plugins.find(item => item.id === 'image-gen')).toMatchObject({
      state: 'needs-setup',
      secretConfigured: false,
    });
  });
});
