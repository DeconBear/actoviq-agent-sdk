import { describe, expect, it, vi } from 'vitest';
import { execFile as nodeExecFile } from 'node:child_process';

import {
  DEFAULT_KIMI_WEBBRIDGE_SESSION,
  KIMI_WEBBRIDGE_ALLOWED_ACTIONS,
  createKimiWebBridgePlugin,
  startKimiWebBridgeDaemon,
} from '../src/plugins/kimiWebBridgePlugin.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Kimi WebBridge plugin', () => {
  it('posts allow-listed commands to the local daemon with a default session', async () => {
    const fetchImpl = vi.fn(async (
      _url: RequestInfo | URL,
      _init?: RequestInit,
    ) => jsonResponse({ success: true, title: 'Example' }));
    const plugin = createKimiWebBridgePlugin({ fetch: fetchImpl as typeof fetch });

    const result = await plugin.command('snapshot');

    expect(result).toEqual({ success: true, title: 'Example' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:10086/command');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'snapshot',
      args: {},
      session: DEFAULT_KIMI_WEBBRIDGE_SESSION,
    });
  });

  it('uses a caller-supplied stable session on every command', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ success: true });
    });
    const plugin = createKimiWebBridgePlugin({
      fetch: fetchImpl as typeof fetch,
      session: 'hadamard-project-cand4',
    });

    await plugin.command('navigate', { url: 'https://www.kimi.com', newTab: true });
    await plugin.command('snapshot');

    expect(requests.map((request) => request.session)).toEqual([
      'hadamard-project-cand4',
      'hadamard-project-cand4',
    ]);
  });

  it('rejects daemon lifecycle and unknown actions before making a request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    const plugin = createKimiWebBridgePlugin({ fetch: fetchImpl as typeof fetch });

    expect(KIMI_WEBBRIDGE_ALLOWED_ACTIONS).not.toContain('stop');
    expect(KIMI_WEBBRIDGE_ALLOWED_ACTIONS).not.toContain('restart');
    expect(KIMI_WEBBRIDGE_ALLOWED_ACTIONS).not.toContain('uninstall');

    for (const action of ['stop', 'restart', 'uninstall', 'arbitrary']) {
      await expect(plugin.command(action as never)).rejects.toThrow(/not allowed/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses list_tabs for a non-mutating connection test', async () => {
    const fetchImpl = vi.fn(async (
      _url: RequestInfo | URL,
      _init?: RequestInit,
    ) => jsonResponse({
      success: true,
      tabs: [{ tabId: 'tab-1', url: 'https://example.com', title: 'Example', active: true }],
    }));
    const plugin = createKimiWebBridgePlugin({ fetch: fetchImpl as typeof fetch });

    const status = await plugin.testConnection();

    expect(status).toMatchObject({
      ok: true,
      state: 'ready',
      session: DEFAULT_KIMI_WEBBRIDGE_SESSION,
      tabCount: 1,
    });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.action).toBe('list_tabs');
    expect(request.action).not.toMatch(/stop|restart|uninstall/);
  });

  it('unwraps the daemon command envelope used by the installed WebBridge', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ok: true,
      data: {
        success: true,
        tabs: [{ tabId: 7, url: 'https://www.kimi.com', title: 'Kimi', active: true }],
      },
    }));
    const plugin = createKimiWebBridgePlugin({ fetch: fetchImpl as typeof fetch });

    const result = await plugin.command('list_tabs');
    const status = await plugin.testConnection();

    expect(result).toMatchObject({ success: true, tabs: [{ tabId: 7 }] });
    expect(status).toMatchObject({ ok: true, state: 'ready', tabCount: 1 });
  });

  it('optionally starts the daemon and retries once only after connection refused', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:10086'), {
        code: 'ECONNREFUSED',
      }),
    });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(jsonResponse({ success: true, tabs: [] }));
    const startDaemon = vi.fn(async () => undefined);
    const plugin = createKimiWebBridgePlugin({
      autoStart: true,
      fetch: fetchImpl as typeof fetch,
      startDaemon,
    });

    const status = await plugin.testConnection();

    expect(status).toMatchObject({ ok: true, state: 'ready', tabCount: 0 });
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one daemon start across concurrent connection-refused commands', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:10086'), {
        code: 'ECONNREFUSED',
      }),
    });
    let fetchCount = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount <= 2) throw refused;
      return jsonResponse({ success: true, tabs: [] });
    });
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startDaemon = vi.fn(() => startGate);
    const plugin = createKimiWebBridgePlugin({
      autoStart: true,
      fetch: fetchImpl as typeof fetch,
      startDaemon,
    });

    const first = plugin.command('list_tabs');
    const second = plugin.command('snapshot');
    await vi.waitFor(() => expect(startDaemon).toHaveBeenCalledTimes(1));
    releaseStart();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('clears a failed start flight so a later command can retry startup', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:10086'), {
        code: 'ECONNREFUSED',
      }),
    });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(jsonResponse({ success: true, tabs: [] }));
    const startDaemon = vi.fn()
      .mockRejectedValueOnce(new Error('daemon start failed'))
      .mockResolvedValueOnce(undefined);
    const plugin = createKimiWebBridgePlugin({
      autoStart: true,
      fetch: fetchImpl as typeof fetch,
      startDaemon,
    });

    await expect(plugin.command('list_tabs')).rejects.toThrow(/start failed/i);
    await expect(plugin.command('list_tabs')).resolves.toEqual({
      success: true,
      tabs: [],
    });
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('starts only the daemon start action with a bounded timeout and kill signal', async () => {
    const execFileMock = vi.mocked(nodeExecFile);
    execFileMock.mockImplementationOnce(((
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => {
      callback(null);
    }) as never);

    await startKimiWebBridgeDaemon({ timeoutMs: 2_500 });

    const call = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
      unknown,
    ];
    expect(call[1]).toEqual(['start']);
    expect(call[1]).not.toContain('stop');
    expect(call[1]).not.toContain('restart');
    expect(call[2]).toMatchObject({
      windowsHide: true,
      timeout: 2_500,
      killSignal: 'SIGKILL',
    });
  });

  it('does not auto-start for unrelated network failures', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('request timed out'));
    const startDaemon = vi.fn(async () => undefined);
    const plugin = createKimiWebBridgePlugin({
      autoStart: true,
      fetch: fetchImpl as typeof fetch,
      startDaemon,
    });

    await expect(plugin.command('list_tabs')).rejects.toThrow(/timed out/i);
    expect(startDaemon).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
