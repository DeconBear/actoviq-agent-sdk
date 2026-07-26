import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'output', 'playwright', 'gui-runtime-model-chat');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-e2e-'));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
const CONFIG = path.join(HOME, 'settings.json');
const screenshots = [];
const providerRequests = [];
const browserErrors = [];
let verifiedBrowserErrors;
let app;
let providerServer;
let failure;

function electronExecutable() {
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (process.platform === 'darwin') {
    return path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function readRequestBody(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function streamChunk(response, model, content, finishReason = null, usage) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-${model}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`);
}

async function startProvider() {
  const replies = {
    'model-alpha': [
      '**Alpha runtime OK**',
      "\n\n```ts\nconst selected = 'model-alpha';",
      '\n```\n\nALPHA_DONE',
    ],
    'model-beta': [
      '**Beta runtime OK**',
      "\n\nThe active model is `model-beta`.",
      '\n\nBETA_DONE',
    ],
  };
  providerServer = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `unexpected path: ${request.url}` } }));
        return;
      }
      const body = await readRequestBody(request);
      providerRequests.push(body);
      if (body.model === 'model-error') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'synthetic provider failure' } }));
        return;
      }
      const chunks = replies[body.model];
      if (!chunks) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `unknown model: ${body.model}` } }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      streamChunk(response, body.model, chunks[0]);
      await new Promise(resolve => setTimeout(resolve, 700));
      streamChunk(response, body.model, chunks[1]);
      await new Promise(resolve => setTimeout(resolve, 250));
      streamChunk(response, body.model, chunks[2], 'stop', {
        prompt_tokens: 11,
        completion_tokens: 9,
        total_tokens: 20,
      });
      response.write('data: [DONE]\n\n');
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => providerServer.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function shot(page, name) {
  const target = path.join(ARTIFACTS, name);
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled' });
  screenshots.push(target);
}

async function apiState(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/state', {
      headers: { 'x-actoviq-token': window.__ACTOVIQ_TOKEN__ },
    });
    if (!response.ok) throw new Error(`state request failed: ${response.status}`);
    return response.json();
  });
}

async function openPicker(page) {
  const flyout = page.locator('#modelPickerFlyout');
  if (await flyout.evaluate(node => node.classList.contains('hidden'))) {
    await page.locator('#modelPickerBtn').click();
  }
  await flyout.waitFor({ state: 'visible' });
}

async function selectAgent(page, name) {
  await openPicker(page);
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/agent/activate') && response.request().method() === 'POST');
  await page.locator(`#modelPickerItems .picker-item[data-agent-name="${name}"]`).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, `agent activation failed for ${name}`);
  const body = await response.json();
  assert.equal(body.activeAgent?.name, name, `expected activeAgent ${name}`);
  await page.locator('#modelPickerBtn').waitFor({ state: 'visible' });
  // The picker button primary label shows the model id (not the profile name).
  const model = body.activeAgent?.model;
  assert.ok(model, `activated agent ${name} missing model`);
  await page.waitForFunction(
    expected => document.getElementById('modelPickerBtn')?.textContent?.includes(expected),
    model,
  );
}

async function closePicker(page) {
  const flyout = page.locator('#modelPickerFlyout');
  if (!(await flyout.evaluate(node => node.classList.contains('hidden')))) {
    await page.locator('#modelPickerBtn').click();
  }
}

async function send(page, text) {
  await page.locator('#promptInput').fill(text);
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/send') && response.request().method() === 'POST');
  await page.locator('#sendBtn').click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, `send failed for: ${text}`);
}

async function waitUntilReady(page) {
  await page.locator('#statusbar').filter({ hasText: /^Ready/ }).waitFor();
}

async function waitForProviderModel(model) {
  const deadline = Date.now() + 10_000;
  while (!providerRequests.some(request => request.model === model)) {
    if (Date.now() > deadline) throw new Error(`provider never received model ${model}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return providerRequests.findLast(request => request.model === model);
}

async function closeApplication() {
  if (!app) return;
  let closed = false;
  await Promise.race([
    app.close().then(() => { closed = true; }),
    new Promise(resolve => setTimeout(resolve, 8_000)),
  ]);
  if (!closed) app.process().kill('SIGKILL');
}

try {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  await mkdir(HOME, { recursive: true });
  await mkdir(WORK, { recursive: true });
  const baseURL = await startProvider();
  const guiPort = await freePort();
  const bridgeConfigs = [
    { name: 'Hadamard Alpha', runtime: 'hadamard', provider: 'openai', apiKey: 'test-key', baseURL, model: 'model-alpha', models: [{ name: 'model-alpha' }] },
    { name: 'Codex Beta', runtime: 'codex', provider: 'openai', apiKey: 'test-key', baseURL, model: 'model-beta', models: [{ name: 'model-beta' }] },
    { name: 'Codex Error', runtime: 'codex', provider: 'openai', apiKey: 'test-key', baseURL, model: 'model-error', models: [{ name: 'model-error' }] },
  ];
  const profiles = [
    { name: 'hadamard-alpha', bridgeConfig: 'Hadamard Alpha', model: 'model-alpha', effort: 'low', temperature: 0.2, maxTokens: 321 },
    { name: 'codex-beta', bridgeConfig: 'Codex Beta', model: 'model-beta', effort: 'high', temperature: 0.4, maxTokens: 654 },
    { name: 'codex-error', bridgeConfig: 'Codex Error', model: 'model-error' },
  ];
  await Promise.all([
    writeFile(CONFIG, JSON.stringify({ env: {
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_BASE_URL: baseURL,
      ACTOVIQ_MODEL: 'model-default',
    } }, null, 2), 'utf8'),
    writeFile(path.join(HOME, 'bridge-configs.json'), JSON.stringify({ configs: bridgeConfigs }, null, 2), 'utf8'),
    writeFile(path.join(HOME, 'agent-configs.json'), JSON.stringify({ version: 1, profiles }, null, 2), 'utf8'),
  ]);

  const env = { ...process.env, ACTOVIQ_HOME: HOME, NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronExecutable(),
    args: [
      path.join(ROOT, 'dist', 'src', 'gui', 'electronMain.js'),
      WORK,
      '--config', CONFIG,
      '--port', String(guiPort),
      '--permission-mode', 'bypassPermissions',
    ],
    cwd: ROOT,
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.getElementById('overviewBody')?.children.length);
  await page.locator('#newSession').evaluate(button => button.click());
  await page.locator('#projectConversation').waitFor({ state: 'visible' });
  await page.locator('#modelPickerBtn').waitFor({ state: 'visible' });

  await openPicker(page);
  await page.locator('[data-agent-name="hadamard-alpha"]').waitFor();
  await page.locator('[data-agent-name="codex-beta"]').waitFor();
  await shot(page, '01-agent-picker.png');

  await selectAgent(page, 'hadamard-alpha');
  const alphaState = await apiState(page);
  assert.equal(alphaState.activeAgent?.model, 'model-alpha');
  assert.equal(alphaState.bridgeState?.activeConfig?.runtime, 'hadamard');
  await page.locator('#workspace').filter({ hasText: 'model-alpha' }).waitFor();
  await shot(page, '02-hadamard-selected.png');
  await closePicker(page);

  const alphaPrompt = 'Verify the selected runtime and render a TypeScript example.';
  await send(page, alphaPrompt);
  const alphaMessage = page.locator('.row-assistant .message.assistant').last();
  await alphaMessage.waitFor();
  await alphaMessage.filter({ hasText: 'Alpha runtime OK' }).waitFor();
  assert(!(await alphaMessage.textContent()).includes('ALPHA_DONE'), 'stream completed before the streaming visual check');
  await shot(page, '03-alpha-streaming.png');
  await alphaMessage.filter({ hasText: 'ALPHA_DONE' }).waitFor();
  await page.locator('.row-assistant .message.assistant strong').filter({ hasText: 'Alpha runtime OK' }).waitFor();
  await page.locator('.row-assistant .message.assistant pre code').filter({ hasText: "const selected = 'model-alpha';" }).waitFor();
  await waitUntilReady(page);
  const alphaRequest = await waitForProviderModel('model-alpha');
  assert.equal(alphaRequest.model, 'model-alpha');
  assert.equal(alphaRequest.temperature, 0.2);
  assert(JSON.stringify(alphaRequest.messages).includes(alphaPrompt));
  await shot(page, '04-alpha-complete.png');

  await selectAgent(page, 'codex-beta');
  const betaState = await apiState(page);
  assert.equal(betaState.activeAgent?.model, 'model-beta');
  assert.equal(betaState.bridgeState?.activeConfig?.runtime, 'codex');
  await page.locator('#workspace').filter({ hasText: 'model-beta' }).waitFor();
  await closePicker(page);
  const betaPrompt = 'Continue this conversation using the newly selected model.';
  await send(page, betaPrompt);
  const betaMessage = page.locator('.row-assistant .message.assistant').last();
  await betaMessage.filter({ hasText: 'BETA_DONE' }).waitFor();
  await waitUntilReady(page);
  const betaRequest = await waitForProviderModel('model-beta');
  assert.equal(betaRequest.temperature, 0.4);
  const betaContext = JSON.stringify(betaRequest.messages);
  assert(betaContext.includes(alphaPrompt), 'model switch lost the prior user context');
  assert(betaContext.includes('ALPHA_DONE'), 'model switch lost the prior assistant context');
  await shot(page, '05-beta-complete.png');

  const previousSessionId = (await apiState(page)).session.id;
  await page.locator('#newSession').evaluate(button => button.click());
  // Fresh chats clear the active agent; the button primary shows session model / Auto.
  await page.waitForFunction(() => {
    const text = document.getElementById('modelPickerBtn')?.textContent || '';
    return text.includes('model-default') || text.includes('Auto') || text.includes('Choose');
  });
  assert.equal(await page.locator('#transcript .message-row').count(), 0);
  await send(page, `/resume ${previousSessionId}`);
  await page.waitForFunction(() => document.getElementById('modelPickerBtn')?.textContent?.includes('model-beta'));
  const resumed = await apiState(page);
  assert.equal(resumed.activeAgent?.name, 'codex-beta');
  await page.locator('#workspace').filter({ hasText: 'model-beta' }).waitFor();
  await page.locator('.row-system, .row-notice').filter({ hasText: previousSessionId }).waitFor();
  await shot(page, '06-resumed-runtime-selection.png');

  await selectAgent(page, 'codex-error');
  await closePicker(page);
  await send(page, 'Show a readable provider error.');
  const errorRows = page.locator('.row-error').filter({ hasText: 'synthetic provider failure' });
  await errorRows.first().waitFor();
  await waitUntilReady(page);
  assert.equal(await errorRows.count(), 1, 'one provider failure rendered more than one error card');
  await page.locator('#sendBtn').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#sendBtn').isEnabled(), true);
  await shot(page, '07-provider-error.png');

  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join('; ')}`);
  verifiedBrowserErrors = [...browserErrors];
} catch (error) {
  failure = error;
  if (app) {
    const windows = app.windows();
    if (windows[0]) await shot(windows[0], '99-failure.png').catch(() => undefined);
  }
} finally {
  await closeApplication().catch(() => app?.process().kill());
  if (providerServer) {
    providerServer.closeAllConnections?.();
    await new Promise(resolve => providerServer.close(resolve));
  }
  await rm(TMP, { recursive: true, force: true });
}

const report = {
  passed: !failure,
  error: failure ? (failure.stack || failure.message || String(failure)) : null,
  providerModels: providerRequests.map(request => request.model),
  browserErrors: verifiedBrowserErrors ?? browserErrors,
  screenshots,
};
await writeFile(path.join(ARTIFACTS, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failure ? 1 : 0);
