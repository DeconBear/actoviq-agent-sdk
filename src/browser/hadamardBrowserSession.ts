import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface HadamardBrowserElementRef {
  index: number;
  tag: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  /** Sensitive controls expose presence only, never the underlying value. */
  hasValue?: boolean;
  href?: string;
}

export interface HadamardBrowserTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface HadamardBrowserSnapshot {
  url: string;
  title: string;
  tabs: HadamardBrowserTabInfo[];
  elements: HadamardBrowserElementRef[];
  truncated: boolean;
}

export interface HadamardBrowserSessionOptions {
  headless?: boolean;
  channel?: 'chromium' | 'chrome' | 'msedge';
  /** Connect to an existing browser via CDP (e.g. chrome://inspect). */
  cdpUrl?: string;
  userDataDir?: string;
  /** Root directory for screenshot output paths. Defaults to process.cwd(). */
  workspaceDir?: string;
  allowedDomains?: string[];
  defaultTimeoutMs?: number;
  viewport?: { width: number; height: number };
}

type PlaywrightModule = typeof import('playwright');
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;
type Frame = import('playwright').Frame;

interface TabHandle {
  id: string;
  page: Page;
}

type BrowserOwnership = 'cdp' | 'persistent' | 'isolated';

const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

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
  var old = document.querySelectorAll('[data-hadamard-idx]');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-hadamard-idx');
  var limited = nodes.slice(0, max);
  return limited.map(function (el, index) {
    el.setAttribute('data-hadamard-idx', String(index));
    var type = (el.getAttribute('type') || '').trim().toLowerCase();
    var autocomplete = (el.getAttribute('autocomplete') || '').trim().toLowerCase();
    var autocompleteTokens = autocomplete.split(/\\s+/).filter(Boolean);
    var sensitive = type === 'password' || autocompleteTokens.some(function (token) {
      return token === 'current-password' ||
        token === 'new-password' ||
        token === 'one-time-code' ||
        token.indexOf('cc-') === 0;
    });
    var rawValue = el.value == null ? '' : String(el.value);
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
      type: type || undefined,
      value: !sensitive && rawValue ? rawValue.slice(0, 120) : undefined,
      hasValue: sensitive ? rawValue.length > 0 : undefined,
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

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function resolveBrowserScreenshotPath(workspaceDir: string, requestedPath: string): string {
  const workspaceRoot = realpathSync.native(path.resolve(workspaceDir));
  const target = path.resolve(workspaceRoot, requestedPath);
  if (target === workspaceRoot || !isPathInside(workspaceRoot, target)) {
    throw new Error(`Browser screenshot path must stay inside the workspace: ${requestedPath}`);
  }

  const canonicalAncestor = realpathSync.native(nearestExistingPath(target));
  if (!isPathInside(workspaceRoot, canonicalAncestor)) {
    throw new Error(`Browser screenshot path resolves outside the workspace: ${requestedPath}`);
  }
  if (existsSync(target)) {
    const canonicalTarget = realpathSync.native(target);
    if (!isPathInside(workspaceRoot, canonicalTarget)) {
      throw new Error(`Browser screenshot path resolves outside the workspace: ${requestedPath}`);
    }
  }
  return target;
}

function pageFunction<TArgs, TResult>(source: string, name: string): (args: TArgs) => TResult {
  // Construct in Node so the browser receives a plain function without __name helpers.
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return ${name};`)() as (args: TArgs) => TResult;
}

export class HadamardBrowserSession {
  private options: Required<
    Pick<HadamardBrowserSessionOptions, 'headless' | 'defaultTimeoutMs'>
  > &
    HadamardBrowserSessionOptions;
  private playwright: PlaywrightModule | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: TabHandle[] = [];
  private activeTabId: string | null = null;
  private nextTabSeq = 1;
  private launched = false;
  private ownership: BrowserOwnership | null = null;
  private closeInFlight: Promise<void> | null = null;
  private guardedPages = new Map<Page, number>();
  private navigationViolations = new Map<Page, { error: Error; recovery: Promise<void> }>();

  constructor(options: HadamardBrowserSessionOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      ...options,
    };
  }

  async ensureReady(): Promise<void> {
    if (this.launched && this.context) return;
    // A previous attempt may have left half-initialized browser handles.
    if (this.browser || this.context || this.ownership) {
      await this.closeOwnedResources().catch(() => undefined);
    }

    try {
      this.playwright = await loadPlaywright();
      const timeout = this.options.defaultTimeoutMs;

      if (this.options.cdpUrl?.trim()) {
        this.browser = await this.playwright.chromium.connectOverCDP(this.options.cdpUrl.trim());
        this.ownership = 'cdp';
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
        this.ownership = 'persistent';
      } else {
        const launcher = channelLauncher(this.playwright, this.options.channel);
        this.browser = await launcher.launch({
          headless: this.options.headless,
          channel: this.options.channel === 'chromium' ? undefined : this.options.channel,
        });
        this.context = await this.browser.newContext({
          viewport: this.options.viewport ?? { width: 1280, height: 800 },
        });
        this.ownership = 'isolated';
      }

      this.context.setDefaultTimeout(timeout);
      this.context.on('page', (page) => {
        this.trackPage(page);
      });
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
    } catch (error) {
      await this.closeOwnedResources().catch(() => undefined);
      throw error;
    }
  }

  async navigate(url: string, opts: { newTab?: boolean } = {}): Promise<{ tabId: string; url: string; title: string }> {
    this.assertNavigableUrl(url);
    await this.ensureReady();
    const tab = opts.newTab ? await this.openTab() : this.requireActiveTab();
    await this.runWithNavigationGuard(
      tab.page,
      () => tab.page.goto(url, { waitUntil: 'domcontentloaded' }),
      { checkBefore: false },
    );
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
    await this.runWithNavigationGuard(
      tab.page,
      () => tab.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined),
    );
    return { url: tab.page.url(), title: await tab.page.title() };
  }

  async wait(ms: number): Promise<void> {
    await this.ensureReady();
    const page = this.requireActiveTab().page;
    await this.runWithNavigationGuard(
      page,
      () => page.waitForTimeout(Math.min(Math.max(ms, 0), 60_000)),
    );
  }

  async snapshot(opts: { interactiveOnly?: boolean; maxElements?: number } = {}): Promise<HadamardBrowserSnapshot> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    const maxElements = opts.maxElements ?? 120;
    const elements = await this.runWithNavigationGuard(
      tab.page,
      () => tab.page.evaluate(
        pageFunction<{ selector: string; max: number }, HadamardBrowserElementRef[]>(
          SNAPSHOT_ELEMENTS_SOURCE,
          'snapshotElements',
        ),
        { selector: INTERACTIVE_SELECTOR, max: maxElements },
      ),
    );

    return {
      url: tab.page.url(),
      title: await tab.page.title(),
      tabs: await this.tabsDetailed(),
      elements: elements as HadamardBrowserElementRef[],
      truncated: elements.length >= maxElements,
    };
  }

  async click(target: { index?: number; x?: number; y?: number }): Promise<{ ok: true }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    if (typeof target.index === 'number') {
      await this.ensureIndexed(tab.page);
      await this.runWithNavigationGuard(
        tab.page,
        () => tab.page.click(`[data-hadamard-idx="${target.index}"]`),
      );
      return { ok: true };
    }
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      await this.runWithNavigationGuard(
        tab.page,
        () => tab.page.mouse.click(target.x!, target.y!),
      );
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
    const locator = tab.page.locator(`[data-hadamard-idx="${input.index}"]`);
    await this.runWithNavigationGuard(tab.page, async () => {
      if (input.clear !== false) {
        await locator.fill(input.text);
      } else {
        await locator.click();
        await tab.page.keyboard.type(input.text);
      }
      if (input.submit) {
        await tab.page.keyboard.press('Enter');
      }
    });
    return { ok: true };
  }

  async press(keys: string): Promise<{ ok: true }> {
    await this.ensureReady();
    const page = this.requireActiveTab().page;
    await this.runWithNavigationGuard(page, () => page.keyboard.press(keys));
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
      await this.runWithNavigationGuard(
        tab.page,
        () => tab.page.locator(`[data-hadamard-idx="${input.index}"]`).scrollIntoViewIfNeeded(),
      );
      return { ok: true };
    }
    const delta = (input.direction === 'down' ? 1 : -1) * pages * 800;
    await this.runWithNavigationGuard(tab.page, () => tab.page.mouse.wheel(0, delta));
    return { ok: true };
  }

  async screenshot(opts: { path?: string; fullPage?: boolean } = {}): Promise<{ path?: string; base64?: string }> {
    await this.ensureReady();
    const tab = this.requireActiveTab();
    if (opts.path?.trim()) {
      const out = resolveBrowserScreenshotPath(
        this.options.workspaceDir ?? process.cwd(),
        opts.path.trim(),
      );
      mkdirSync(path.dirname(out), { recursive: true });
      await this.runWithNavigationGuard(
        tab.page,
        () => tab.page.screenshot({ path: out, fullPage: opts.fullPage === true }),
      );
      return { path: out };
    }
    const buffer = await this.runWithNavigationGuard(
      tab.page,
      () => tab.page.screenshot({ fullPage: opts.fullPage === true, type: 'png' }),
    );
    return { base64: buffer.toString('base64') };
  }

  listTabs(): HadamardBrowserTabInfo[] {
    return this.tabs.map((tab) => {
      const currentUrl = tab.page.url();
      let safeUrl = 'about:blank';
      try {
        this.assertManagedPageUrl(currentUrl);
        safeUrl = currentUrl;
      } catch {
        // Avoid exposing a local/disallowed URL through the synchronous helper.
      }
      return {
        id: tab.id,
        url: safeUrl,
        title: '',
        active: tab.id === this.activeTabId,
      };
    });
  }

  async tabsDetailed(): Promise<HadamardBrowserTabInfo[]> {
    await this.ensureReady();
    const out: HadamardBrowserTabInfo[] = [];
    for (const tab of this.tabs) {
      await this.enforceAllowedPage(tab.page);
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
    await this.enforceAllowedPage(tab.page);
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
    const text = await this.runWithNavigationGuard(
      tab.page,
      () => tab.page.evaluate(
        pageFunction<void, string>(EXTRACT_TEXT_SOURCE, 'extractText'),
      ),
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
    const result = await this.runWithNavigationGuard(
      tab.page,
      () => tab.page.evaluate(
        pageFunction<string, unknown>(EVAL_EXPR_SOURCE, 'evalExpression'),
        expression,
      ),
    );
    return { result };
  }

  close(): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight;
    this.closeInFlight = this.closeOwnedResources().finally(() => {
      this.closeInFlight = null;
    });
    return this.closeInFlight;
  }

  private async closeOwnedResources(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    const ownership = this.ownership;
    const failures: Error[] = [];

    try {
      // A CDP context belongs to the user's already-running browser. Never close it.
      if (context && ownership !== 'cdp') {
        await withTimeout(
          context.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          'Timed out while closing the Playwright browser context.',
        ).catch((error) => {
          failures.push(toError(error));
        });
      }
      // For a CDP connection Browser.close() disconnects this Playwright client.
      if (browser?.isConnected()) {
        await withTimeout(
          browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          'Timed out while disconnecting the Playwright browser.',
        ).catch((error) => {
          failures.push(toError(error));
        });
      }
    } finally {
      // Always clear session bookkeeping, even when Playwright close/disconnect
      // fails. Leaving launched/context set after a partial teardown lets later
      // ensureReady() short-circuit onto a dead browser.
      this.tabs = [];
      this.activeTabId = null;
      this.context = null;
      this.browser = null;
      this.ownership = null;
      this.launched = false;
      this.guardedPages.clear();
      this.navigationViolations.clear();
    }

    if (failures.length > 0) {
      throw new Error(
        `Failed to close the browser session: ${failures.map((error) => error.message).join('; ')}`,
        { cause: failures[0] },
      );
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
      this.guardedPages.delete(page);
      this.navigationViolations.delete(page);
      if (this.activeTabId === id) {
        this.activeTabId = this.tabs[0]?.id ?? null;
      }
    });
    page.on('framenavigated', (frame) => {
      this.onTrackedFrameNavigated(page, frame);
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
    await this.enforceAllowedPage(page);
    const count = await page.locator('[data-hadamard-idx]').count();
    if (count === 0) {
      await this.snapshot();
    }
  }

  private assertNavigableUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Navigation blocked: protocol ${parsed.protocol || '(none)'} is not allowed. Only http: and https: URLs are supported.`,
      );
    }

    const allowed = this.options.allowedDomains?.filter(Boolean) ?? [];
    if (allowed.length === 0) return;
    const hostname = parsed.hostname.toLowerCase();
    const ok = allowed.some((rule) => {
      const trimmed = rule.trim().toLowerCase();
      let normalized = '';
      try {
        normalized = new URL(
          /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
        ).hostname.toLowerCase();
      } catch {
        return false;
      }
      if (!normalized) return false;
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
    if (!ok) {
      throw new Error(
        `Navigation blocked: ${hostname} is not in allowedDomains (${allowed.join(', ')}).`,
      );
    }
  }

  private assertManagedPageUrl(url: string): void {
    if (url === 'about:blank') return;
    this.assertNavigableUrl(url);
  }

  private onTrackedFrameNavigated(page: Page, frame: Frame): void {
    if ((this.guardedPages.get(page) ?? 0) <= 0) return;
    if (frame !== page.mainFrame()) return;
    try {
      this.assertManagedPageUrl(frame.url());
    } catch (error) {
      this.scheduleNavigationRecovery(page, toError(error));
    }
  }

  private scheduleNavigationRecovery(
    page: Page,
    error: Error,
  ): { error: Error; recovery: Promise<void> } {
    const existing = this.navigationViolations.get(page);
    if (existing) return existing;

    const violation = {
      error,
      recovery: Promise.resolve().then(async () => {
        if (page.isClosed() || page.url() === 'about:blank') return;
        await page.goto('about:blank', {
          waitUntil: 'commit',
          timeout: Math.min(this.options.defaultTimeoutMs, 5_000),
        }).catch(() => undefined);
      }),
    };
    this.navigationViolations.set(page, violation);
    return violation;
  }

  private async enforceAllowedPage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const pending = this.navigationViolations.get(page);
    if (pending) {
      await pending.recovery;
      this.navigationViolations.delete(page);
      throw pending.error;
    }

    try {
      this.assertManagedPageUrl(page.url());
    } catch (error) {
      const violation = this.scheduleNavigationRecovery(page, toError(error));
      await violation.recovery;
      this.navigationViolations.delete(page);
      throw violation.error;
    }
  }

  private armNavigationGuard(page: Page): void {
    this.guardedPages.set(page, (this.guardedPages.get(page) ?? 0) + 1);
  }

  private disarmNavigationGuard(page: Page): void {
    const count = this.guardedPages.get(page) ?? 0;
    if (count <= 1) {
      this.guardedPages.delete(page);
    } else {
      this.guardedPages.set(page, count - 1);
    }
  }

  private async runWithNavigationGuard<T>(
    page: Page,
    operation: () => Promise<T>,
    options: { checkBefore?: boolean } = {},
  ): Promise<T> {
    if (options.checkBefore !== false) {
      await this.enforceAllowedPage(page);
    }
    const pagesBefore = new Set(this.tabs.map((tab) => tab.page));
    this.armNavigationGuard(page);

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    let guardError: unknown;
    try {
      await this.enforceAllowedPage(page);
      for (const tab of this.tabs) {
        if (!pagesBefore.has(tab.page)) {
          await this.enforceAllowedPage(tab.page);
        }
      }
    } catch (error) {
      guardError = error;
    } finally {
      this.disarmNavigationGuard(page);
    }

    if (guardError) throw guardError;
    if (operationError) throw operationError;
    return result as T;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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

function channelLauncher(pw: PlaywrightModule, channel: HadamardBrowserSessionOptions['channel']) {
  if (channel === 'chrome' || channel === 'msedge') return pw.chromium;
  return pw.chromium;
}
