import {
  createActoviqBrowserTools,
  createActoviqBrowserUseToolkit,
} from '../src/browser/actoviqBrowserTools.js';
import {
  readActoviqBrowserSettings,
  writeActoviqBrowserSettings,
} from '../src/browser/browserSettings.js';
import { describe, expect, it, vi } from 'vitest';

describe('browser-use toolkit', () => {
  it('exposes browser-use style tools with a shared mock session', async () => {
    const session = {
      navigate: vi.fn(async (url: string) => ({ tabId: 't1', url, title: 'Example' })),
      goBack: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example' })),
      wait: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({
        url: 'https://example.com/',
        title: 'Example',
        tabs: [{ id: 't1', url: 'https://example.com/', title: 'Example', active: true }],
        elements: [{ index: 0, tag: 'a', role: 'link', name: 'More information' }],
        truncated: false,
      })),
      click: vi.fn(async () => ({ ok: true as const })),
      type: vi.fn(async () => ({ ok: true as const })),
      press: vi.fn(async () => ({ ok: true as const })),
      scroll: vi.fn(async () => ({ ok: true as const })),
      screenshot: vi.fn(async () => ({ path: '/tmp/shot.png' })),
      tabsDetailed: vi.fn(async () => [{ id: 't1', url: 'https://example.com/', title: 'Example', active: true }]),
      switchTab: vi.fn(async (tabId: string) => ({ ok: true as const, tabId })),
      closeTab: vi.fn(async (tabId?: string) => ({ ok: true as const, closed: tabId ?? 't1' })),
      extract: vi.fn(async () => ({ url: 'https://example.com/', title: 'Example', text: 'Hello' })),
      evaluate: vi.fn(async () => ({ result: 1 })),
      close: vi.fn(async () => undefined),
    };

    const toolkit = createActoviqBrowserUseToolkit({ session, allowEvaluate: true });
    const names = toolkit.tools.map((tool) => tool.name).sort();
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_type');
    expect(names).toContain('browser_evaluate');

    const navigate = toolkit.tools.find((tool) => tool.name === 'browser_navigate')!;
    await navigate.execute({ url: 'https://example.com/' }, {} as never);
    expect(session.navigate).toHaveBeenCalledWith('https://example.com/', { newTab: undefined });

    const snapshot = toolkit.tools.find((tool) => tool.name === 'browser_snapshot')!;
    const snap = await snapshot.execute({}, {} as never);
    expect(snap).toMatchObject({ url: 'https://example.com/', elements: [{ index: 0 }] });

    const click = toolkit.tools.find((tool) => tool.name === 'browser_click')!;
    await click.execute({ index: 0 }, {} as never);
    expect(session.click).toHaveBeenCalledWith({ index: 0 });
  });

  it('omits browser_evaluate unless allowEvaluate is set', () => {
    const tools = createActoviqBrowserTools({
      session: {
        navigate: async () => ({ tabId: 't1', url: 'https://example.com/', title: 'x' }),
        goBack: async () => ({ url: 'https://example.com/', title: 'x' }),
        wait: async () => undefined,
        snapshot: async () => ({ url: '', title: '', tabs: [], elements: [], truncated: false }),
        click: async () => ({ ok: true as const }),
        type: async () => ({ ok: true as const }),
        press: async () => ({ ok: true as const }),
        scroll: async () => ({ ok: true as const }),
        screenshot: async () => ({}),
        tabsDetailed: async () => [],
        switchTab: async (tabId) => ({ ok: true as const, tabId }),
        closeTab: async () => ({ ok: true as const, closed: 't1' }),
        extract: async () => ({ url: '', title: '', text: '' }),
        close: async () => undefined,
      },
    });
    expect(tools.some((tool) => tool.name === 'browser_evaluate')).toBe(false);
  });

  it('reads and writes browser settings from settings.json shape', () => {
    const raw: Record<string, unknown> = {};
    writeActoviqBrowserSettings(raw, {
      enabled: true,
      headless: false,
      channel: 'chrome',
      allowedDomains: ['example.com'],
      allowEvaluate: false,
    });
    expect(readActoviqBrowserSettings(raw)).toMatchObject({
      enabled: true,
      headless: false,
      channel: 'chrome',
      allowedDomains: ['example.com'],
      allowEvaluate: false,
    });
  });
});
