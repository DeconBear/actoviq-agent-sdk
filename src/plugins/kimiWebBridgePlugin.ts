import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_KIMI_WEBBRIDGE_ENDPOINT = 'http://127.0.0.1:10086/command';
export const DEFAULT_KIMI_WEBBRIDGE_SESSION = 'actoviq-kimi-webbridge';

export const KIMI_WEBBRIDGE_ALLOWED_ACTIONS = [
  'navigate',
  'find_tab',
  'snapshot',
  'click',
  'fill',
  'evaluate',
  'cdp',
  'screenshot',
  'network',
  'upload',
  'save_as_pdf',
  'list_tabs',
  'close_tab',
  'close_session',
] as const;

export type KimiWebBridgeAction = typeof KIMI_WEBBRIDGE_ALLOWED_ACTIONS[number];

export interface KimiWebBridgePluginOptions {
  endpoint?: string;
  session?: string;
  fetch?: typeof globalThis.fetch;
  autoStart?: boolean;
  timeoutMs?: number;
  startDaemon?: () => Promise<void>;
}

export interface KimiWebBridgeConnectionStatus {
  ok: boolean;
  state: 'ready' | 'unavailable' | 'error';
  session: string;
  tabCount: number;
  message: string;
}

export interface KimiWebBridgePlugin {
  readonly id: 'kimi-webbridge';
  readonly endpoint: string;
  readonly session: string;
  command(
    action: KimiWebBridgeAction,
    args?: Record<string, unknown>,
  ): Promise<unknown>;
  testConnection(): Promise<KimiWebBridgeConnectionStatus>;
}

export interface KimiWebBridgeDaemonStartOptions {
  timeoutMs?: number;
}

const allowedActions = new Set<string>(KIMI_WEBBRIDGE_ALLOWED_ACTIONS);

export function createKimiWebBridgePlugin(
  options: KimiWebBridgePluginOptions = {},
): KimiWebBridgePlugin {
  const endpoint = normalizeLocalEndpoint(
    options.endpoint?.trim() || DEFAULT_KIMI_WEBBRIDGE_ENDPOINT,
  );
  const session = options.session?.trim() || DEFAULT_KIMI_WEBBRIDGE_SESSION;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const startDaemon = options.startDaemon ?? startKimiWebBridgeDaemon;
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  let daemonStartInFlight: Promise<void> | undefined;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Kimi WebBridge requires a fetch implementation.');
  }

  async function postCommand(
    action: KimiWebBridgeAction,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    let envelope: unknown;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, args, session }),
        signal: controller.signal,
      });
      envelope = await readResponsePayload(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Kimi WebBridge request timed out after ${timeoutMs} ms.`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Kimi WebBridge request failed with HTTP ${response.status}.`);
    }
    if (isRecord(envelope) && envelope.ok === false) {
      const detail = typeof envelope.error === 'string' ? ` ${envelope.error}` : '';
      throw new Error(`Kimi WebBridge command failed.${detail}`);
    }
    const payload = isRecord(envelope) && envelope.ok === true && 'data' in envelope
      ? envelope.data
      : envelope;
    if (isRecord(payload) && payload.success === false) {
      const detail = typeof payload.error === 'string'
        ? ` ${payload.error}`
        : '';
      throw new Error(`Kimi WebBridge command failed.${detail}`);
    }
    return payload;
  }

  function startDaemonSingleFlight(): Promise<void> {
    if (daemonStartInFlight) {
      return daemonStartInFlight;
    }
    const flight = Promise.resolve().then(() => startDaemon());
    daemonStartInFlight = flight;
    const clearFlight = () => {
      if (daemonStartInFlight === flight) {
        daemonStartInFlight = undefined;
      }
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  async function command(
    action: KimiWebBridgeAction,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!allowedActions.has(action)) {
      throw new TypeError(`Kimi WebBridge action is not allowed: ${String(action)}`);
    }

    try {
      return await postCommand(action, args);
    } catch (error) {
      if (!options.autoStart || !isConnectionRefused(error)) {
        throw error;
      }
      await startDaemonSingleFlight();
      return postCommand(action, args);
    }
  }

  async function testConnection(): Promise<KimiWebBridgeConnectionStatus> {
    try {
      const result = await command('list_tabs');
      const tabs = isRecord(result) && Array.isArray(result.tabs)
        ? result.tabs
        : [];
      return {
        ok: true,
        state: 'ready',
        session,
        tabCount: tabs.length,
        message: 'Kimi WebBridge daemon and browser extension are ready.',
      };
    } catch (error) {
      return {
        ok: false,
        state: isConnectionRefused(error) ? 'unavailable' : 'error',
        session,
        tabCount: 0,
        message: safeErrorMessage(error),
      };
    }
  }

  return {
    id: 'kimi-webbridge',
    endpoint,
    session,
    command,
    testConnection,
  };
}

function normalizeLocalEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Kimi WebBridge daemon URL must be a valid local HTTP URL.');
  }
  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'http:' || !loopback) {
    throw new TypeError('Kimi WebBridge daemon URL must use HTTP on localhost.');
  }
  return parsed.toString().replace(/\/$/u, '');
}

export async function startKimiWebBridgeDaemon(
  options: KimiWebBridgeDaemonStartOptions = {},
): Promise<void> {
  const executable = process.platform === 'win32'
    ? path.join(os.homedir(), '.kimi-webbridge', 'bin', 'kimi-webbridge.exe')
    : path.join(os.homedir(), '.kimi-webbridge', 'bin', 'kimi-webbridge');
  const timeoutMs = Math.max(
    1_000,
    Math.min(120_000, options.timeoutMs ?? 15_000),
  );

  await new Promise<void>((resolve, reject) => {
    execFileCallback(
      executable,
      ['start'],
      {
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

function isConnectionRefused(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && !visited.has(current)) {
    visited.add(current);
    if (isRecord(current)) {
      if (current.code === 'ECONNREFUSED') {
        return true;
      }
      if (
        typeof current.message === 'string'
        && /ECONNREFUSED|connection refused/i.test(current.message)
      ) {
        return true;
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Kimi WebBridge connection failed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
