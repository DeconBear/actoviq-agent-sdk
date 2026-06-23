import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(port: number, requestPath: string, headers: http.OutgoingHttpHeaders): Promise<RawResponse> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.end();
  });
}

describe('GUI server auth gates', () => {
  it('requires a valid token and rejects foreign host/origin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-sec-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const port = 46000 + Math.floor(Math.random() * 9000);
    const server = await startActoviqGuiServer({ workDir, homeDir, host: '127.0.0.1', port, configPath });
    const actualPort = Number(new URL(server.url).port);
    const goodHost = `127.0.0.1:${actualPort}`;

    try {
      // No token → 403.
      const noToken = await rawRequest(actualPort, '/api/state', { host: goodHost });
      expect(noToken.status).toBe(403);

      // Valid token → 200.
      const withToken = await rawRequest(actualPort, '/api/state', { host: goodHost, 'x-actoviq-token': server.token });
      expect(withToken.status).toBe(200);

      // Foreign Host header (DNS-rebinding) → 403 even with a valid token.
      const badHost = await rawRequest(actualPort, '/api/state', { host: 'evil.example.com', 'x-actoviq-token': server.token });
      expect(badHost.status).toBe(403);

      // Cross-site Origin → 403.
      const badOrigin = await rawRequest(actualPort, '/api/state', { host: goodHost, origin: 'http://evil.example.com', 'x-actoviq-token': server.token });
      expect(badOrigin.status).toBe(403);

      // The HTML entrypoint ships a CSP header and the bootstrap token.
      const page = await rawRequest(actualPort, '/', { host: goodHost });
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.body).toContain('window.__ACTOVIQ_TOKEN__');
    } finally {
      await server.close();
    }
  });
});
