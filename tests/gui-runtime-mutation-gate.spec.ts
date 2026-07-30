import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
import { saveRouterProfile } from '../src/router/modelRouter.js';
import { saveWorkflow } from '../src/workflow/workflowPersistence.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function api<T>(
  server: Awaited<ReturnType<typeof startActoviqGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(requestPath.replace(/^\/+/, ''), server.url), {
    ...init,
    headers: {
      'x-actoviq-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() as T };
}

async function startDeferredProvider(): Promise<{
  url: string;
  calls: () => number;
  release: () => void;
  close: () => Promise<void>;
}> {
  let callCount = 0;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (_req, res) => {
    callCount += 1;
    await released;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'test provider released', type: 'invalid_request_error' } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls: () => callCount,
    release,
    close: () => closeHttpServer(server),
  };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

async function waitForProviderCall(calls: () => number): Promise<void> {
  for (let attempt = 0; attempt < 200 && calls() === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(calls()).toBeGreaterThan(0);
}

async function startConfiguredGui(prefix: string, providerUrl: string) {
  const root = await tempRoot(prefix);
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  const configPath = path.join(homeDir, 'settings.json');
  await mkdir(workDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    env: {
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_BASE_URL: providerUrl,
      ACTOVIQ_MODEL: 'test-model',
    },
  }), 'utf8');
  const server = await startActoviqGuiServer({
    workDir,
    homeDir,
    configPath,
    host: '127.0.0.1',
    port: 45000 + Math.floor(Math.random() * 10000),
  });
  return { server, workDir };
}

const jsonRequest = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('GUI runtime mutation gate', () => {
  it('keeps workflow runs leased and rejects runtime/session mutations until cleanup', async () => {
    const provider = await startDeferredProvider();
    const { server, workDir } = await startConfiguredGui('actoviq-gui-runtime-gate-workflow-', provider.url);
    try {
      await saveWorkflow('lease-test', [
        'export const meta = { name: "lease-test", description: "gate test" };',
        'await agent("hold this workflow");',
      ].join('\n'), { projectDir: workDir });
      await saveRouterProfile({
        name: 'configured',
        routerModel: { model: 'test-model' },
        routes: [{ model: 'test-model', when: 'always' }],
      }, { projectDir: workDir });
      const initial = await api<{ session: { id: string } }>(server, '/api/state');
      const workflowResponse = await fetch(new URL('api/send', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actoviq-token': server.token,
        },
        body: JSON.stringify({ text: '/workflows run lease-test' }),
      });
      const workflowCompletion = workflowResponse.text();
      await waitForProviderCall(provider.calls);

      const mutations: Array<{ path: string; init: RequestInit }> = [
        {
          path: '/api/router/profile',
          init: jsonRequest({
            name: 'during-run',
            routerModel: { model: 'test-model' },
            routes: [{ model: 'test-model', when: 'always' }],
          }),
        },
        { path: '/api/router/profile/delete', init: jsonRequest({ name: 'during-run' }) },
        { path: '/api/router/activate', init: jsonRequest({ name: 'configured' }) },
        { path: '/api/session/delete', init: jsonRequest({ id: initial.body.session.id }) },
        { path: '/api/session/archive', init: jsonRequest({ id: initial.body.session.id }) },
        { path: '/api/session/unarchive', init: jsonRequest({ id: initial.body.session.id }) },
        {
          path: '/api/session-center/action',
          init: jsonRequest({
            action: 'archive',
            locator: {
              scope: 'project',
              projectPath: workDir,
              sessionId: initial.body.session.id,
              archived: false,
            },
          }),
        },
        { path: '/api/hooks', init: jsonRequest({}, 'PUT') },
        { path: '/api/manager/config', init: jsonRequest({ model: 'test-model' }) },
        {
          path: '/api/agent-profiles',
          init: jsonRequest({ name: 'reviewer', bridgeConfig: 'missing', model: 'test-model' }),
        },
        { path: '/api/agent-profiles/delete', init: jsonRequest({ name: 'reviewer' }) },
        { path: '/api/team/preferences', init: jsonRequest({ autoInvoke: true }) },
        { path: '/api/settings', init: jsonRequest({ preferences: {} }) },
        {
          path: '/api/customize/plugins',
          init: jsonRequest({ action: 'install', id: 'ocr' }),
        },
        {
          path: '/api/customize/plugins/test',
          init: jsonRequest({ id: 'playwright' }),
        },
        { path: '/api/app-update/upgrade', init: jsonRequest({}) },
        { path: '/api/project/open', init: jsonRequest({ path: workDir }) },
        { path: '/api/mcp/add', init: jsonRequest({ name: 'gate-test', command: 'node' }) },
      ];
      for (const mutation of mutations) {
        const blocked = await api<{ error: string }>(server, mutation.path, mutation.init);
        expect(blocked.status, mutation.path).toBe(409);
        expect(blocked.body.error, mutation.path).toContain('workflow:lease-test');
      }

      provider.release();
      await workflowCompletion;
      const allowed = await api<{ ok: boolean }>(
        server,
        '/api/team/preferences',
        jsonRequest({ autoInvoke: false }),
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.ok).toBe(true);
    } finally {
      provider.release();
      await server.close();
      await provider.close();
    }
  }, 30_000);

  it('leases an unregistered Team proposal run before awaiting the provider', async () => {
    const provider = await startDeferredProvider();
    const { server } = await startConfiguredGui('actoviq-gui-runtime-gate-proposal-', provider.url);
    try {
      const proposal = api<{ error?: string }>(server, '/api/team/propose', jsonRequest({
        instruction: 'Create a review team',
        squadType: 'graph',
      }));
      await waitForProviderCall(provider.calls);

      const blocked = await api<{ error: string }>(
        server,
        '/api/team/preferences',
        jsonRequest({ autoInvoke: true }),
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toContain('team:proposal');

      provider.release();
      await proposal;
      const allowed = await api<{ ok: boolean }>(
        server,
        '/api/team/preferences',
        jsonRequest({ autoInvoke: false }),
      );
      expect(allowed.status).toBe(200);
    } finally {
      provider.release();
      await server.close();
      await provider.close();
    }
  }, 30_000);
});
