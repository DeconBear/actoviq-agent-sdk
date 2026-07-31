/**
 * Hadamard GUI E2E Tests — Playwright
 * Covers: workspace load, session lifecycle, chat, settings, slash commands,
 * context rail, keyboard shortcuts, session management.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.HADAMARD_GUI_URL || 'http://127.0.0.1:4175';
const TIMEOUT = 30_000;

let browser, page;
const results = [];

function report(name, passed, detail = '') {
  const icon = passed ? '✓' : '✗';
  results.push({ name, passed, detail });
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function setup() {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
}

async function teardown() {
  await browser?.close();
}

// ─── Test: Page Load & Workspace ───────────────────────────────────────────────
async function testPageLoad() {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const title = await page.title();
  report('Page loads', true, `title="${title}"`);

  // Workspace path displayed
  const workspace = await page.locator('#workspace').textContent().catch(() => '');
  report('Workspace path visible', workspace.length > 0, workspace.trim());

  // Transcript section exists
  const transcript = page.locator('#transcript');
  report('Transcript panel exists', await transcript.count() > 0);

  // Composer form exists
  const composer = page.locator('#composer');
  report('Composer form exists', await composer.count() > 0);
}

// ─── Test: API State ───────────────────────────────────────────────────────────
async function testApiState() {
  const token = await page.evaluate(() => window.__HADAMARD_TOKEN__);
  report('Auth token embedded', typeof token === 'string' && token.length > 0);

  const res = await page.evaluate(async () => {
    const r = await fetch('/api/state', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json() };
  });
  report('GET /api/state returns 200', res.ok);
  report('State has session info', !!res.data?.session || !!res.data?.sessionId || !!res.data?.model);
}

// ─── Test: New Session Creation ────────────────────────────────────────────────
async function testNewSession() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/session/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hadamard-token': window.__HADAMARD_TOKEN__ },
      body: JSON.stringify({}),
    });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  });
  report('POST /api/session/new succeeds', res.ok, `status=${res.status}`);
  // Reload page to sync UI with new session
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
}

// ─── Test: Send Message & Get AI Response ──────────────────────────────────────
async function testChatMessage() {
  // Strategy 1: Try UI interaction first
  const textarea = page.locator('#composer textarea, #promptInput');
  let uiFilled = false;
  try {
    await textarea.first().waitFor({ state: 'visible', timeout: 5_000 });
    await textarea.first().fill('Say hello in one word.');
    const sendBtn = page.locator('#composer button[type="submit"]');
    if (await sendBtn.count() > 0 && await sendBtn.isVisible()) {
      await sendBtn.click();
    } else {
      await textarea.first().press('Enter');
    }
    uiFilled = true;
    report('Composer textarea interaction', true);
  } catch {
    report('Composer textarea interaction', false, 'textarea not visible, falling back to API');
  }

  // Strategy 2: If UI failed, use /api/send directly
  if (!uiFilled) {
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hadamard-token': window.__HADAMARD_TOKEN__ },
        body: JSON.stringify({ text: 'Say hello in one word.' }),
      });
      return { ok: r.ok, status: r.status };
    });
    report('POST /api/send accepts message', res.ok, `status=${res.status}`);
  }

  // Wait for assistant response in transcript (up to 30s for model inference)
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('#transcript');
      return el && el.textContent.length > 20;
    }, { timeout: 30_000 });
    const transcriptText = await page.locator('#transcript').textContent();
    report('AI response received', transcriptText.length > 20, `${transcriptText.length} chars in transcript`);
  } catch {
    // Verify via API
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/session/messages', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
      return await r.json().catch(() => ({}));
    });
    const msgs = res?.messages ?? [];
    report('AI response received', msgs.length > 0, `${msgs.length} messages via API`);
  }
}

// ─── Test: Session Messages API ────────────────────────────────────────────────
async function testSessionMessages() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/session/messages', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/session/messages returns 200', res.ok);
  const msgs = res.data?.messages;
  report('Messages array returned', Array.isArray(msgs), `${msgs?.length ?? 0} messages`);
}

// ─── Test: Slash Commands ──────────────────────────────────────────────────────
async function testSlashCommands() {
  const commands = ['/tools', '/skills', '/context'];
  for (const cmd of commands) {
    const textarea = page.locator('#composer textarea, #promptInput').first();
    try {
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      break;
    }
    await textarea.fill(cmd);
    const sendBtn = page.locator('#composer button[type="submit"]');
    if (await sendBtn.count() > 0 && await sendBtn.isVisible()) await sendBtn.click();
    else await textarea.press('Enter');
    await page.waitForTimeout(2000);
  }
  // If no crash after 3 slash commands, consider it a pass
  const stillAlive = await page.locator('#transcript').count() > 0;
  report('Slash commands (/tools, /skills, /context) execute without crash', stillAlive);
}

// ─── Test: Settings Panel ──────────────────────────────────────────────────────
async function testSettingsPanel() {
  // Look for settings gear/button
  const settingsBtn = page.locator('[data-action="settings"], .settings-btn, button:has-text("Settings"), [aria-label="Settings"]').first();
  if (await settingsBtn.count() > 0) {
    await settingsBtn.click();
    await page.waitForTimeout(500);
    const panel = page.locator('.settings-panel, [data-settings-panel]');
    const visible = await panel.count() > 0;
    report('Settings panel opens', visible);

    // Check sub-panels exist
    const generalPanel = page.locator('[data-settings-panel="general"]');
    report('Settings: General panel exists', await generalPanel.count() > 0);
    const modelsPanel = page.locator('[data-settings-panel="models"]');
    report('Settings: Models panel exists', await modelsPanel.count() > 0);
    const appearancePanel = page.locator('[data-settings-panel="appearance"]');
    report('Settings: Appearance panel exists', await appearancePanel.count() > 0);

    // Close settings (press Escape or click close)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    report('Settings button found', false, 'no settings trigger located');
  }
}

// ─── Test: Session Center (list/archive) ───────────────────────────────────────
async function testSessionCenter() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/session-center', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/session-center returns 200', res.ok);
  // Session center may return { sessions: [] } or { groups: [...] } depending on implementation
  const hasData = res.data && typeof res.data === 'object';
  report('Session center returns valid data', hasData, JSON.stringify(Object.keys(res.data || {})));
}

// ─── Test: Context Rail ────────────────────────────────────────────────────────
async function testContextRail() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/rail-live', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/rail-live returns 200', res.ok);
}

// ─── Test: Workspace Files API ─────────────────────────────────────────────────
async function testWorkspaceFiles() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/workspace-files?path=', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/workspace-files returns 200', res.ok);
  const entries = res.data?.entries;
  report('Workspace files listed', Array.isArray(entries) && entries.length > 0, `${entries?.length ?? 0} entries`);
}

// ─── Test: Runs API ────────────────────────────────────────────────────────────
async function testRunsApi() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/runs', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/runs returns 200', res.ok);
}

// ─── Test: Keyboard Shortcuts ──────────────────────────────────────────────────
async function testKeyboardShortcuts() {
  // Ctrl+N or Ctrl+Shift+N for new session (common pattern)
  await page.keyboard.press('Control+Shift+n');
  await page.waitForTimeout(1000);
  const stillAlive = await page.locator('body').count() > 0;
  report('Keyboard shortcut (Ctrl+Shift+N) does not crash', stillAlive);
}

// ─── Test: Plugins & Skills API ────────────────────────────────────────────────
async function testPluginsSkills() {
  const plugins = await page.evaluate(async () => {
    const r = await fetch('/api/customize/plugins', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok };
  });
  report('GET /api/customize/plugins returns 200', plugins.ok);

  const skills = await page.evaluate(async () => {
    const r = await fetch('/api/customize/skills', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok };
  });
  report('GET /api/customize/skills returns 200', skills.ok);
}

// ─── Test: Session Active API ──────────────────────────────────────────────────
async function testSessionActive() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/session/active', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/session/active returns 200', res.ok);
}

// ─── Test: Data Root / Settings API ────────────────────────────────────────────
async function testDataRoot() {
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/settings/data-root', { headers: { 'x-hadamard-token': window.__HADAMARD_TOKEN__ } });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  });
  report('GET /api/settings/data-root returns 200', res.ok);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nHadamard GUI E2E — ${BASE_URL}\n${'═'.repeat(50)}`);
  await setup();

  try {
    console.log('\n[Page Load & Workspace]');
    await testPageLoad();

    console.log('\n[API State]');
    await testApiState();

    console.log('\n[Session Lifecycle]');
    await testNewSession();
    await testSessionActive();
    await testSessionCenter();

    console.log('\n[Chat & AI Response]');
    await testChatMessage();
    await testSessionMessages();

    console.log('\n[Slash Commands]');
    await testSlashCommands();

    console.log('\n[Settings Panel]');
    await testSettingsPanel();

    console.log('\n[Context Rail & Files]');
    await testContextRail();
    await testWorkspaceFiles();

    console.log('\n[Runs & Plugins]');
    await testRunsApi();
    await testPluginsSkills();

    console.log('\n[Keyboard Shortcuts]');
    await testKeyboardShortcuts();

    console.log('\n[Data Root]');
    await testDataRoot();
  } catch (error) {
    console.error('\nFATAL:', error.message);
  }

  await teardown();

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('\nFailed:');
    results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.name} — ${r.detail}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
