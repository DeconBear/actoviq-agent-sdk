import type { CreateActoviqBrowserUseOptions } from '../types.js';

export interface ActoviqBrowserSettings extends CreateActoviqBrowserUseOptions {
  /** When true, GUI/SDK hosts may auto-attach browser tools. */
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readActoviqBrowserSettings(raw: Record<string, unknown> | null | undefined): ActoviqBrowserSettings {
  const source = isRecord(raw?.browser) ? raw.browser : {};
  const allowedDomains = Array.isArray(source.allowedDomains)
    ? source.allowedDomains.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  const channel =
    source.channel === 'chrome' || source.channel === 'msedge' || source.channel === 'chromium'
      ? source.channel
      : undefined;
  return {
    enabled: source.enabled === true,
    headless: typeof source.headless === 'boolean' ? source.headless : undefined,
    channel,
    cdpUrl: typeof source.cdpUrl === 'string' ? source.cdpUrl : undefined,
    userDataDir: typeof source.userDataDir === 'string' ? source.userDataDir : undefined,
    allowedDomains,
    defaultTimeoutMs:
      typeof source.defaultTimeoutMs === 'number' && Number.isFinite(source.defaultTimeoutMs)
        ? Math.max(1_000, Math.min(180_000, Math.trunc(source.defaultTimeoutMs)))
        : undefined,
    allowEvaluate: source.allowEvaluate === true,
  };
}

export function writeActoviqBrowserSettings(
  raw: Record<string, unknown>,
  patch: Partial<ActoviqBrowserSettings>,
): Record<string, unknown> {
  const current = readActoviqBrowserSettings(raw);
  const next: ActoviqBrowserSettings = {
    ...current,
    ...patch,
  };
  raw.browser = {
    enabled: next.enabled === true,
    headless: next.headless !== false,
    ...(next.channel ? { channel: next.channel } : {}),
    ...(next.cdpUrl?.trim() ? { cdpUrl: next.cdpUrl.trim() } : {}),
    ...(next.userDataDir?.trim() ? { userDataDir: next.userDataDir.trim() } : {}),
    ...(next.allowedDomains && next.allowedDomains.length > 0
      ? { allowedDomains: next.allowedDomains }
      : {}),
    ...(typeof next.defaultTimeoutMs === 'number'
      ? { defaultTimeoutMs: next.defaultTimeoutMs }
      : {}),
    allowEvaluate: next.allowEvaluate === true,
  };
  return raw;
}
