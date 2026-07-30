import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AuditEvent {
  id: string;
  type: string;
  actor: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly filePath: string) {}

  async append(event: AuditEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(redact(event))}\n`, 'utf8');
  }

  async list(limit = 200): Promise<AuditEvent[]> {
    try {
      return (await readFile(this.filePath, 'utf8'))
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(-limit)
        .map(line => JSON.parse(line) as AuditEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

function redact(value: unknown, key = ''): unknown {
  if (/secret|token|password|api.?key|authorization/iu.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]),
    );
  }
  return value;
}
