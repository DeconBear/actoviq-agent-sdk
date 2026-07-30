export const REMOTE_PROTOCOL_VERSION = 1 as const;

export type RemoteJobStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RemoteJobRequest {
  id: string;
  projectPath: string;
  sessionId?: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  artifactNames?: string[];
  createdAt: string;
}

export interface RemoteJobRecord extends RemoteJobRequest {
  status: RemoteJobStatus;
  updatedAt: string;
  attempts: number;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  result?: {
    text: string;
    artifactNames?: string[];
  };
  error?: string;
}

export type RemoteWorkerMessage =
  | { version: 1; type: 'worker.hello'; workerId: string; capabilities: string[] }
  | { version: 1; type: 'job.submit'; job: RemoteJobRequest }
  | { version: 1; type: 'job.lease'; workerId: string; leaseMs: number }
  | { version: 1; type: 'job.heartbeat'; jobId: string; workerId: string; leaseToken: string; leaseMs: number }
  | { version: 1; type: 'job.complete'; jobId: string; workerId: string; leaseToken: string; text: string; artifactNames?: string[] }
  | { version: 1; type: 'job.fail'; jobId: string; workerId: string; leaseToken: string; error: string };

export function parseRemoteWorkerMessage(value: unknown): RemoteWorkerMessage {
  if (!isRecord(value) || value.version !== REMOTE_PROTOCOL_VERSION || typeof value.type !== 'string') {
    throw new Error('Invalid remote worker protocol envelope.');
  }
  const json = value as unknown as RemoteWorkerMessage;
  switch (json.type) {
    case 'worker.hello':
      if (typeof json.workerId === 'string' && Array.isArray(json.capabilities)) return json;
      break;
    case 'job.submit':
      if (isRecord(json.job) && typeof json.job.id === 'string') return json;
      break;
    case 'job.lease':
      if (typeof json.workerId === 'string' && validLease(json.leaseMs)) return json;
      break;
    case 'job.heartbeat':
      if (validOwnedJobMessage(json) && validLease(json.leaseMs)) return json;
      break;
    case 'job.complete':
      if (validOwnedJobMessage(json) && typeof json.text === 'string') return json;
      break;
    case 'job.fail':
      if (validOwnedJobMessage(json) && typeof json.error === 'string') return json;
      break;
  }
  throw new Error(`Invalid remote worker message: ${value.type}`);
}

function validOwnedJobMessage(
  value: { jobId?: unknown; workerId?: unknown; leaseToken?: unknown },
): boolean {
  return typeof value.jobId === 'string'
    && typeof value.workerId === 'string'
    && typeof value.leaseToken === 'string';
}

function validLease(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
