#!/usr/bin/env node
import http from 'node:http';
import process from 'node:process';
import path from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const hostIndex = argv.indexOf('--host');
if (argv[0] !== 'server' || hostIndex < 0 || !argv[hostIndex + 1]) {
  process.stderr.write('fake crush requires: server --host <local socket>\n');
  process.exit(2);
}

const serverHost = argv[hostIndex + 1];
const socketPath = serverHost.startsWith('npipe:////./pipe/')
  ? `\\\\.\\pipe\\${serverHost.slice('npipe:////./pipe/'.length)}`
  : serverHost.startsWith('unix://')
    ? serverHost.slice('unix://'.length)
    : '';
if (!socketPath) {
  process.stderr.write('fake crush refuses non-local transports\n');
  process.exit(2);
}

const subscribers = new Set();
let currentSessionId = '';
let configuredProvider = '';
let configuredModel = '';
let configuredBaseURL = '';
let configuredApiKey = false;
const persistedSessionPath = process.env.CRUSH_GLOBAL_DATA
  ? path.join(process.env.CRUSH_GLOBAL_DATA, 'fake-crush-session.json')
  : undefined;

function sendJson(response, value, statusCode = 200) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendEmpty(response, statusCode = 200) {
  response.writeHead(statusCode, { 'content-length': '0' });
  response.end();
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.once('error', reject);
    request.once('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function emit(kind, data) {
  const frame = `data: ${JSON.stringify({
    type: kind,
    payload: { type: 'updated', payload: data },
  })}\n\n`;
  for (const response of subscribers) response.write(frame);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/v1/health') {
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/workspaces') {
    await readJson(request);
    sendJson(response, { id: 'workspace-1' });
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/config/set')) {
    const body = await readJson(request);
    configuredProvider = String(body.key ?? '').split('.')[1] ?? configuredProvider;
    configuredBaseURL = typeof body.value === 'string' ? body.value : '';
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/config/provider-key')) {
    const body = await readJson(request);
    configuredProvider = typeof body.provider_id === 'string' ? body.provider_id : configuredProvider;
    configuredApiKey = typeof body.api_key === 'string' && body.api_key.length > 0;
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/config/model')) {
    const body = await readJson(request);
    configuredProvider = typeof body.model?.provider === 'string'
      ? body.model.provider
      : configuredProvider;
    configuredModel = typeof body.model?.model === 'string' ? body.model.model : '';
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/sessions')) {
    currentSessionId = 'crush-session-1';
    if (persistedSessionPath) {
      await mkdir(path.dirname(persistedSessionPath), { recursive: true });
      await writeFile(persistedSessionPath, currentSessionId, 'utf8');
    }
    sendJson(response, { id: currentSessionId });
    return;
  }
  const existingSession = pathname.match(/\/sessions\/([^/]+)$/u);
  if (request.method === 'GET' && existingSession) {
    currentSessionId = decodeURIComponent(existingSession[1]);
    if (persistedSessionPath) {
      const persisted = await access(persistedSessionPath).then(() => true, () => false);
      if (!persisted) {
        sendJson(response, { error: 'missing persisted session' }, 404);
        return;
      }
    }
    sendJson(response, { id: currentSessionId });
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/permissions/skip')) {
    await readJson(request);
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/agent/init')) {
    sendEmpty(response);
    return;
  }
  if (request.method === 'GET' && pathname.endsWith('/agent')) {
    sendJson(response, { is_ready: true });
    return;
  }
  if (request.method === 'GET' && pathname.endsWith('/events')) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders();
    subscribers.add(response);
    response.once('close', () => subscribers.delete(response));
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/current-session')) {
    const body = await readJson(request);
    currentSessionId = typeof body.session_id === 'string' ? body.session_id : currentSessionId;
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname.endsWith('/agent')) {
    const body = await readJson(request);
    const sessionId = body.session_id || currentSessionId;
    const runId = body.run_id;
    const text = body.prompt === 'who-am-i'
      ? 'crush:agent:inherit'
      : body.prompt === 'check-env'
        ? `crush:env:${process.env.CRUSH_OPENAI_API_KEY ?? ''}:isolated=${Boolean(
            process.env.CRUSH_GLOBAL_CONFIG && process.env.XDG_CONFIG_HOME && process.env.CRUSH_CACHE_DIR
          )}`
        : body.prompt === 'check-isolation'
          ? `crush:isolation:selected=${Boolean(process.env.CRUSH_OPENAI_API_KEY)}:github=${Boolean(process.env.GITHUB_TOKEN)}:aws=${Boolean(process.env.AWS_SECRET_ACCESS_KEY)}:db=${Boolean(process.env.DATABASE_PASSWORD)}`
        : body.prompt === 'check-config'
          ? `crush:config:${configuredProvider}:${configuredModel}:${configuredBaseURL}:key=${configuredApiKey}`
        : `crush:${body.prompt ?? ''}`;
    sendEmpty(response, 202);
    queueMicrotask(() => {
      emit('message', {
        id: 'assistant-1',
        role: 'assistant',
        session_id: sessionId,
        run_id: runId,
        parts: [{ type: 'text', data: { text } }],
      });
      emit('run_complete', { session_id: sessionId, run_id: runId, text });
    });
    return;
  }
  if (request.method === 'POST' && pathname.includes('/agent/sessions/') && pathname.endsWith('/cancel')) {
    sendEmpty(response);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/control') {
    sendEmpty(response);
    setImmediate(() => server.close(() => process.exit(0)));
    return;
  }
  sendJson(response, { error: `unhandled ${request.method} ${pathname}` }, 404);
});

server.listen(socketPath);
