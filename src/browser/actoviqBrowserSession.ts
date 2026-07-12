import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface ActoviqBrowserElementRef {
  index: number;
  tag: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  href?: string;
}

export interface ActoviqBrowserTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ActoviqBrowserSnapshot {
  url: string;
  title: string;
  tabs: ActoviqBrowserTabInfo[];
  elements: ActoviqBrowserElementRef[];
  truncated: boolean;
}

export interface ActoviqBrowserSessionOptions {
  headless?: boolean;
  channel?: 'chromium' | 'chrome' | 'msedge';
  /** Connect to an existing browser via CDP (e.g. chrome://inspect). */
  cdpUrl?: string;
  userDataDir?: string;
  allowedDomains?: string[];
  defaultTimeoutMs?: number;
  viewport?: { width: number; height: number };
}

type PlaywrightModule = typeof import('playwright');
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;

interface TabHandle {
  id: string;
  page: Page;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
].join(',');

/** Browser-side helpers as source strings so tsx/esbuild never inject __name into page.evaluate. */
const SNAPSHOT_ELEMENTS_SOURCE = `function snapshotElements(args) {
  var selector = args.selector;
  var max = args.max;
  function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  var nodes = Array.prototype.slice.call(document.querySelectorAll(selector)).filter(isVisible);
  var old = document.querySelectorAll('[data-actoviq-idx]');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-actoviq-idx');
  var limited = nodes.slice(0, max);
  return limited.map(function (el, index) {
    el.setAttribute('data-actoviq-idx', String(index));
    var name =
      el.getAttribute('aria-label') ||
      el.getAttribute('name') ||
      el.getAttribute('placeholder') ||
      ((el.innerText || el.textContent || '').trim().slice(0, 80)) ||
      el.getAttribute('title') ||
      '';
    return {
      index: index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: name,
      type: el.getAttribute('type') || undefined,
      value: el.value ? String(el.value).slice(0, 120) : undefined,
      href: el.href || undefined,
    };
  });
}`;

const EXTRACT_TEXT_SOURCE = `function extractText() {
  var root = document.body || document.documentElement;
  return ((root && root.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 20000);
}`;

const EVAL_EXPR_SOURCE = `function evalExpression(expr) {
  return eval(expr);
}`;

function pageFunction<TArgs, TResult>(source: string, name: string): (args: TArgs) => TResult {
  // Construct in Node so the browser receives a plain function without __name helpers.
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return ${name};`)() as (args: TArgs) => TResult;
}

export class ActoviqBrowserSession {
  private options: Required<
    Pick<ActoviqBrowserSessionOptions, 'headless' | 'defaultTimeoutMs'>
  > &
    ActoviqBrowserSessionOptions;
  private playwright: PlaywrightModule | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: TabHandle[] = [];
  private activeTabId: string | null = null;
  private nextTabSeq = 1;
  private launched = false;

  constructor(options: ActoviqBrowserSessionOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      ...options,
    };
  }

  async ensureReady(): Promise<void> {
    if (this.launched && this.context) return;
    this.playwright = await loadPlaywright();
    const timeout = this.options.defaultTimeoutMs;

    if (this.options.cdpUrl?.trim()) {
      this.browser = await this.playwright.chromium.connectOverCDP(this.options.cdpUrl.trim());
      const contexts = this.browser.contexts();
      this.context = contexts[0] ?? (await this.browser.newContext({
        viewport: this.options.viewport ?? { width: 1280, height: 800 },
      }));
    } else if (this.options.userDataDir?.trim()) {
      const userDataDir = path.resolve(this.options.userDataDir.trim());
      mkdirSync(userDataDir, { recursive: true });
      const launcher = channelLauncher(this.playwright, this.options.channel);
      this.context = await launcher.launchPersistentContext(userDataDir, {
        headless: this.options.headless,
        viewport: this.options.viewport ?? { width: 1280, height: 800 },
        channel: this.options.channel === 'chromium' ? undefined : this.options.channel,
      });
      this.browser = this.context.browser();
    } else {
      const launcher = channelLauncher(this.playwright, this.options.channel);
      this.browser = await launcher.launch({
        headless: this.options.headless,
        channel: this.options.channel === 'chromium' ? undefined : this.options.channel,
      });
      this.context = await this.browser.newContext({
        viewport: this.options.viewport ?? { width: 1280, height: 800 },
      });
    }

    this.context.setDefaultTimeout(timeout);
    for (const page of this.context.pages()) {
      this.trackPage(page);
    }
    if (this.tabs.length === 0) {
      const page = await this.context.newPage();
      this.trackPage(page);
    }
    if (!this.activeTabId) {
      this.activeTabId = this.tabs[0]?.id ?? null;
    }
    this.launched = true;
  }

  async navigate(url: string, opts: { newTab?: boolean } = {}): Promise<{ tabId: string; url: string; title: string }> {
    await this.ensureReady();
    this.assertAllowedUrl(url);
    const tab = opts.newTab ? await this.openTab() : this.requireActiveTab();
    await tab.page.goto(url, { waitUntil: 'domcontentloaded' });
    this.activeTabId = tab.id;
    return {
      tabId: tab.id,
      url: tab.page.url(),
      title: await tab.page.title(),
    };
  }

  async goBack(): Promise<{ url: string; title: string }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    await tab.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return { url: tab.page.url(), title: await tab.page.title() };
  }

  async wait(ms: number): Promise<void> {
    await this.ensureReady();
    await this.requireActiveTab().page.waitForTimeout(Math.min(Math.max(ms, 0), 60_000));
  }

  async snapshot(opts: { interactiveOnly?: boolean; maxElements?: number } = {}): Promise<ActoviqBrowserSnapshot> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    const maxElements = opts.maxElements ?? 120;
    const elements = await tab.page.evaluate(
      pageFunction<{ selector: string; max: number }, ActoviqBrowserElementRef[]>(
        SNAPSHOT_ELEMENTS_SOURCE,
        'snapshotElements',
      ),
      { selector: INTERACTIVE_SELECTOR, max: maxElements },
    );

    return {
      url: tab.page.url(),
      title: await tab.page.title(),
      tabs: this.listTabs(),
      elements: elements as ActoviqBrowserElementRef[],
      truncated: elements.length >= maxElements,
    };
  }

  async click(target: { index?: number; x?: number; y?: number }): Promise<{ ok: true }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    if (typeof target.index === 'number') {
      await this.ensureIndexed(tab.page);
      await tab.page.click(`[data-actoviq-idx="${target.index}"]`);
      return { ok: true };
    }
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      await tab.page.mouse.click(target.x, target.y);
      return { ok: true };
    }
    throw new Error('browser_click requires index or x/y coordinates.');
  }

  async type(input: {
    index: number;
    text: string;
    clear?: boolean;
    submit?: boolean;
  }): Promise<{ ok: true }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    await this.ensureIndexed(tab.page);
    const locator = tab.page.locator(`[data-actoviq-idx="${input.index}"]`);
    if (input.clear !== false) {
      await locator.fill(input.text);
    } else {
      await locator.click();
      await tab.page.keyboard.type(input.text);
    }
    if (input.submit) {
      await tab.page.keyboard.press('Enter');
    }
    return { ok: true };
  }

  async press(keys: string): Promise<{ ok: true }> {
    await this.ensureReady();
    await this.requireActiveTab().page.keyboard.press(keys);
    return { ok: true };
  }

  async scroll(input: {
    direction: 'up' | 'down';
    pages?: number;
    index?: number;
  }): Promise<{ ok: true }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    const pages = Math.min(Math.max(input.pages ?? 1, 1), 10);
    if (typeof input.index === 'number') {
      await this.ensureIndexed(tab.page);
      await tab.page.locator(`[data-actoviq-idx="${input.index}"]`).scrollIntoViewIfNeeded();
      return { ok: true };
    }
    const delta = (input.direction === 'down' ? 1 : -1) * pages * 800;
    await tab.page.mouse.wheel(0, delta);
    return { ok: true };
  }

  async screenshot(opts: { path?: string; fullPage?: boolean } = {}): Promise<{ path?: string; base64?: string }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    if (opts.path?.trim()) {
      const out = path.resolve(opts.path.trim());
      mkdirSync(path.dirname(out), { recursive: true });
      await tab.page.screenshot({ path: out, fullPage: opts.fullPage === true });
      return { path: out };
    }
    const buffer = await tab.page.screenshot({ fullPage: opts.fullPage === true, type: 'png' });
    return { base64: buffer.toString('base64') };
  }

  listTabs(): ActoviqBrowserTabInfo[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      url: tab.page.url(),
      title: '',
      active: tab.id === this.activeTabId,
    }));
  }

  async tabsDetailed(): Promise<ActoviqBrowserTabInfo[]> {
    await this.ensureReady();
    const out: ActoviqBrowserTabInfo[] = [];
    for (const tab of this.tabs) {
      out.push({
        id: tab.id,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        active: tab.id === this.activeTabId,
      });
    }
    return out;
  }

  async switchTab(tabId: string): Promise<{ ok: true; tabId: string }> {
    await this.ensureReady();
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error(`Unknown tab id: ${tabId}`);
    this.activeTabId = tab.id;
    await tab.page.bringToFront().catch(() => undefined);
    return { ok: true, tabId };
  }

  async closeTab(tabId?: string): Promise<{ ok: true; closed: string }> {
    await this.ensureReady();
    const id = tabId ?? this.activeTabId;
    if (!id) throw new Error('No active browser tab to close.');
    const idx = this.tabs.findIndex((item) => item.id === id);
    if (idx < 0) throw new Error(`Unknown tab id: ${id}`);
    const removed = this.tabs[idx]!;
    this.tabs.splice(idx, 1);
    await removed.page.close({ runBeforeUnload: false }).catch(() => undefined);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.id ?? null;
    }
    if (this.tabs.length === 0 && this.context) {
      const page = await this.context.newPage();
      this.trackPage(page);
      this.activeTabId = this.tabs[0]?.id ?? null;
    }
    return { ok: true, closed: id };
  }

  async extract(): Promise<{ url: string; title: string; text: string }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    const text = await tab.page.evaluate(
      pageFunction<void, string>(EXTRACT_TEXT_SOURCE, 'extractText'),
    );
    return {
      url: tab.page.url(),
      title: await tab.page.title(),
      text,
    };
  }

  async evaluate(expression: string): Promise<{ result: unknown }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    const result = await tab.page.evaluate(
      pageFunction<string, unknown>(EVAL_EXPR_SOURCE, 'evalExpression'),
      expression,
    );
    return { result };
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.tabs = [];
    this.activeTabId = null;
    this.context = null;
    this.browser = null;
    this.launched = false;
    await context?.close().catch(() => undefined);
    // Persistent context already closed the browser; CDP connect should disconnect.
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => undefined);
    }
  }

  private async openTab(): Promise<TabHandle> {
    await this.ensureReady();
    const page = await this.context!.newPage();
    return this.trackPage(page);
  }

  private trackPage(page: Page): TabHandle {
    const existing = this.tabs.find((tab) => tab.page === page);
    if (existing) return existing;
    const id = `t${this.nextTabSeq++}`;
    const tab: TabHandle = { id, page };
    this.tabs.push(tab);
    page.on('close', () => {
      this.tabs = this.tabs.filter((item) => item.id !== id);
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs[0]?.id ?? null;
      }
    });
    if (!this.activeTabId) this.activeTabId = id;
    return tab;
  }

  private requireActiveTab(): TabHandle {
    const tab = this.tabs.find((item) => item.id === this.activeTabId) ?? this.tabs[0];
    if (!tab) throw new Error('No browser tab is open. Call browser_navigate first.');
    this.activeTabId = tab.id;
    return tab;
  }

  private async ensureIndexed(page: Page): Promise<void> {
    const count = await page.locator('[data-actoviq-idx]').count();
    if (count === 0) {
      await this.snapshot();
    }
  }

  private assertAllowedUrl(url: string): void {
    const allowed = this.options.allowedDomains?.filter(Boolean) ?? [];
    if (allowed.length === 0) return;
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    const ok = allowed.some((rule) => {
      const normalized = rule.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
      if (!normalized) return false;
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
    if (!ok) {
      throw new Error(
        `Navigation blocked: ${hostname} is not in allowedDomains (${allowed.join(', ')}).`,
      );
    }
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(
      'Playwright is required for browser-use tools. Install it with `npm i playwright` and run `npx playwright install chromium`.',
      { cause: error },
    );
  }
}

function channelLauncher(pw: PlaywrightModule, channel: ActoviqBrowserSessionOptions['channel']) {
  if (channel === 'chrome' || channel === 'msedge') return pw.chromium;
  return pw.chromium;
}
