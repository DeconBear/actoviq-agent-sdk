import {
  createActoviqBrowserTools,
  createActoviqBrowserUseToolkit,
  type ActoviqBrowserSessionLike,
} from '../src/browser/actoviqBrowserTools.js';
import {
  readActoviqBrowserSettings,
  writeActoviqBrowserSettings,
} from '../src/browser/browserSettings.js';
import {
  ActoviqBrowserSession,
  resolveBrowserScreenshotPath,
} from '../src/browser/actoviqBrowserSession.js';
import { decideActoviqToolPermission } from '../src/runtime/actoviqPermissions.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function createNoopBrowserSession(): ActoviqBrowserSessionLike {
  return {
    navigate: async (url) => ({ tabId: 't1', url, title: 'Example' }),
    goBack: async () => ({ url: 'https://example.com/', title: 'Example' }),
    wait: async () => undefined,
    snapshot: async () => ({ url: '', title: '', tabs: [], elements: [], truncated: false }),
    click: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    press: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    screenshot: async () => ({}),
    tabsDetailed: async () => [],
    switchTab: async (tabId) => ({ ok: true, tabId }),
    closeTab: async () => ({ ok: true, closed: 't1' }),
    extract: async () => ({ url: '', title: '', text: '' }),
    evaluate: async () => ({ result: undefined }),
    close: async () => undefined,
  };
}

function installFakePage(
  session: ActoviqBrowserSession,
  options: {
    initialUrl?: string;
    onGoto?: (url: string) => string;
    onAction?: (action: 'click' | 'type' | 'press') => string | undefined;
    evaluate?: (fn: (args: unknown) => unknown, args: unknown) => unknown;
  } = {},
) {
  let currentUrl = options.initialUrl ?? 'https://allowed.test/';
  let closed = false;
  const updateAfterAction = (action: 'click' | 'type' | 'press') => {
    currentUrl = options.onAction?.(action) ?? currentUrl;
  };
  const page = {
    url: () => currentUrl,
    title: vi.fn(async () => 'Test page'),
    isClosed: () => closed,
    goto: vi.fn(async (url: string) => {
      currentUrl = options.onGoto?.(url) ?? url;
      return null;
    }),
    goBack: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: (args: unknown) => unknown, args: unknown) =>
      options.evaluate ? options.evaluate(fn, args) : undefined),
    locator: vi.fn(() => ({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => updateAfterAction('click')),
      fill: vi.fn(async () => updateAfterAction('type')),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    })),
    click: vi.fn(async () => updateAfterAction('click')),
    mouse: {
      click: vi.fn(async () => updateAfterAction('click')),
      wheel: vi.fn(async () => undefined),
    },
    keyboard: {
      type: vi.fn(async () => updateAfterAction('type')),
      press: vi.fn(async () => updateAfterAction('press')),
    },
    screenshot: vi.fn(async () => Buffer.from('png')),
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      closed = true;
    }),
  };
  const context = {
    pages: () => [page],
    setDefaultTimeout: vi.fn(),
    on: vi.fn(),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  Object.assign(session as unknown as Record<string, unknown>, {
    launched: true,
    context,
    tabs: [{ id: 't1', page }],
    activeTabId: 't1',
  });
  return { page, getUrl: () => currentUrl };
}

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

  it.each([
    'file:///C:/Users/example/.ssh/id_rsa',
    'data:text/html,secret',
    'javascript:alert(1)',
    'about:blank',
  ])('rejects non-HTTP public navigation before launching Playwright: %s', async (url) => {
    const session = new ActoviqBrowserSession();
    await expect(session.navigate(url)).rejects.toThrow(/only http: and https:/i);
  });

  it('enforces allowedDomains on initial navigation before launching Playwright', async () => {
    const session = new ActoviqBrowserSession({ allowedDomains: ['allowed.test'] });
    await expect(session.navigate('https://blocked.test/')).rejects.toThrow(
      /not in allowedDomains/i,
    );
  });

  it('returns to about:blank and throws when an HTTP redirect leaves allowedDomains', async () => {
    const session = new ActoviqBrowserSession({ allowedDomains: ['allowed.test'] });
    const fake = installFakePage(session, {
      initialUrl: 'about:blank',
      onGoto: (url) =>
        url === 'https://allowed.test/redirect' ? 'https://blocked.test/private' : url,
    });

    await expect(session.navigate('https://allowed.test/redirect')).rejects.toThrow(
      /not in allowedDomains/i,
    );
    expect(fake.getUrl()).toBe('about:blank');
    expect(fake.page.goto).toHaveBeenLastCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'commit' }),
    );
  });

  it.each(['click', 'type', 'press'] as const)(
    'returns to about:blank when browser_%s navigates outside allowedDomains',
    async (action) => {
      const session = new ActoviqBrowserSession({ allowedDomains: ['allowed.test'] });
      const fake = installFakePage(session, {
        onAction: (performed) =>
          performed === action ? 'https://blocked.test/private' : undefined,
      });

      const invocation = action === 'click'
        ? session.click({ index: 0 })
        : action === 'type'
          ? session.type({ index: 0, text: 'go' })
          : session.press('Enter');
      await expect(invocation).rejects.toThrow(/not in allowedDomains/i);
      expect(fake.getUrl()).toBe('about:blank');
    },
  );

  it('redacts password, OTP, and payment values from browser snapshots', async () => {
    const makeNode = (
      attributes: Record<string, string>,
      value: string,
    ) => ({
      tagName: 'INPUT',
      value,
      innerText: '',
      textContent: '',
      href: undefined,
      getAttribute: (name: string) => attributes[name] ?? null,
      getBoundingClientRect: () => ({ width: 120, height: 24 }),
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    });
    const nodes = [
      makeNode({ type: 'password', name: 'password' }, 'p@ssw0rd'),
      makeNode({ type: 'text', autocomplete: 'current-password' }, 'current-secret'),
      makeNode({ type: 'text', autocomplete: 'one-time-code' }, '123456'),
      makeNode({ type: 'text', autocomplete: 'section-pay cc-number' }, '4111111111111111'),
      makeNode({ type: 'text', autocomplete: 'new-password' }, ''),
      makeNode({ type: 'text', name: 'username' }, 'alice'),
    ];
    vi.stubGlobal('window', {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    });
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) =>
        selector === '[data-actoviq-idx]' ? [] : nodes,
    });

    try {
      const session = new ActoviqBrowserSession({ allowedDomains: ['allowed.test'] });
      installFakePage(session, {
        evaluate: (fn, args) => fn(args),
      });
      const snapshot = await session.snapshot();

      for (const element of snapshot.elements.slice(0, 4)) {
        expect(element.value).toBeUndefined();
        expect(element.hasValue).toBe(true);
      }
      expect(snapshot.elements[4]).toMatchObject({ hasValue: false });
      expect(snapshot.elements[4]?.value).toBeUndefined();
      expect(snapshot.elements[5]).toMatchObject({ value: 'alice' });
      expect(JSON.stringify(snapshot)).not.toContain('p@ssw0rd');
      expect(JSON.stringify(snapshot)).not.toContain('4111111111111111');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forces every browser tool through interactive approval for CDP and persistent profiles', () => {
    for (const reuseOptions of [
      { cdpUrl: 'http://127.0.0.1:9222' },
      { userDataDir: '.actoviq/browser-profile' },
    ]) {
      const tools = createActoviqBrowserTools({
        ...reuseOptions,
        session: createNoopBrowserSession(),
        allowEvaluate: true,
      });
      expect(tools.length).toBeGreaterThan(0);
      for (const definition of tools) {
        expect(definition.requiresUserInteraction?.(), definition.name).toBe(true);
      }
    }

    const isolated = createActoviqBrowserTools({
      session: createNoopBrowserSession(),
      allowEvaluate: true,
    });
    for (const definition of isolated) {
      expect(definition.requiresUserInteraction?.(), definition.name).toBe(false);
    }
  });

  it('still asks for approval in bypassPermissions when controlling a CDP session', async () => {
    const click = createActoviqBrowserTools({
      cdpUrl: 'http://127.0.0.1:9222',
      session: createNoopBrowserSession(),
    }).find((definition) => definition.name === 'browser_click')!;
    const approver = vi.fn(async () => ({
      behavior: 'allow' as const,
      reason: 'approved host-browser interaction',
    }));

    const decision = await decideActoviqToolPermission({
      mode: 'bypassPermissions',
      rules: [],
      approver,
      adapter: click,
      runId: 'browser-run',
      workDir: process.cwd(),
      toolName: click.name,
      publicName: click.name,
      prompt: 'click',
      toolInput: { index: 0 },
      iteration: 1,
    });

    expect(decision.behavior).toBe('allow');
    expect(approver).toHaveBeenCalledTimes(1);
  });

  it('disconnects CDP without closing the user context and clears session state on failure', async () => {
    const context = { close: vi.fn(async () => undefined) };
    const browser = {
      isConnected: vi.fn(() => true),
      close: vi.fn()
        .mockRejectedValueOnce(new Error('disconnect failed'))
        .mockResolvedValueOnce(undefined),
    };
    const session = new ActoviqBrowserSession({ cdpUrl: 'http://127.0.0.1:9222' });
    Object.assign(session as unknown as Record<string, unknown>, {
      context,
      browser,
      ownership: 'cdp',
      launched: true,
    });

    await expect(session.close()).rejects.toThrow(/disconnect failed/i);
    expect(context.close).not.toHaveBeenCalled();
    // Partial teardown must still drop local handles so ensureReady cannot
    // short-circuit onto a dead browser after a failed disconnect.
    expect((session as unknown as Record<string, unknown>).browser).toBeNull();
    expect((session as unknown as Record<string, unknown>).context).toBeNull();
    expect((session as unknown as Record<string, unknown>).launched).toBe(false);

    // Second close is a no-op once bookkeeping is cleared.
    await expect(session.close()).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
  });

  it('cleans half-initialized browser handles before retrying ensureReady', async () => {
    const context = { close: vi.fn(async () => undefined) };
    const browser = {
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    };
    // Unreachable CDP endpoint: after clearing stale handles, launch should fail.
    const session = new ActoviqBrowserSession({ cdpUrl: 'http://127.0.0.1:1' });
    Object.assign(session as unknown as Record<string, unknown>, {
      context,
      browser,
      ownership: 'isolated',
      launched: false,
    });

    await expect(session.ensureReady()).rejects.toThrow();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect((session as unknown as Record<string, unknown>).browser).toBeNull();
    expect((session as unknown as Record<string, unknown>).context).toBeNull();
    expect((session as unknown as Record<string, unknown>).launched).toBe(false);
  });

  it('keeps screenshot output paths inside the configured workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-browser-output-'));
    try {
      await mkdir(path.join(root, 'artifacts'), { recursive: true });
      expect(resolveBrowserScreenshotPath(root, 'artifacts/page.png')).toBe(
        path.join(root, 'artifacts', 'page.png'),
      );
      expect(() => resolveBrowserScreenshotPath(root, '../outside.png')).toThrow(
        /must stay inside the workspace/i,
      );
      expect(() => resolveBrowserScreenshotPath(root, path.join(path.dirname(root), 'outside.png')))
        .toThrow(/must stay inside the workspace/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
