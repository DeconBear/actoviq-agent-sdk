import type { HookHandlerAdapter } from '../hookTypes.js';

export const runHttpHook: HookHandlerAdapter = async ({ definition, input, signal }) => {
  if (definition.handler.type !== 'http') throw new Error('Expected HTTP hook.');
  const url = new URL(definition.handler.url);
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new Error('HTTP hooks require HTTPS unless the target is loopback.');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(definition.handler.headers ?? {}),
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP hook returned ${response.status}.`);
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  return {
    behavior: value.behavior === 'block' ? 'block' : 'continue',
    ...(typeof value.feedback === 'string' ? { feedback: value.feedback } : {}),
    data: value,
  };
};

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
