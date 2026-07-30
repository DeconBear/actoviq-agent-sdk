export const APP_SERVER_PROTOCOL_VERSION = 1 as const;

export interface AppServerRequest {
  version: 1;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AppServerResponse {
  version: 1;
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AppServerNotification {
  version: 1;
  type: 'event';
  method: string;
  params: Record<string, unknown>;
}

export function parseAppServerRequest(value: unknown): AppServerRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid app-server request.');
  const request = value as Partial<AppServerRequest>;
  if (
    request.version !== APP_SERVER_PROTOCOL_VERSION
    || typeof request.id !== 'string'
    || typeof request.method !== 'string'
    || (request.params !== undefined
      && (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)))
  ) throw new Error('Invalid app-server request.');
  return request as AppServerRequest;
}
