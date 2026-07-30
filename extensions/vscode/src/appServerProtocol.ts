export interface AppServerWireMessage {
  id?: string;
  type?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

export function encodeAppServerRequest(
  id: string,
  method: string,
  params: Record<string, unknown>,
): string {
  return `${JSON.stringify({ version: 1, id, method, params })}\n`;
}

export function decodeAppServerMessage(line: string): AppServerWireMessage | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as AppServerWireMessage;
  } catch {
    return undefined;
  }
}
