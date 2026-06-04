import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BenchmarkTrajectoryEvent } from './types.js';

export type BenchmarkTrajectoryEventInput =
  Omit<BenchmarkTrajectoryEvent, 'eventId' | 'timestamp'> &
  Partial<Pick<BenchmarkTrajectoryEvent, 'eventId' | 'timestamp'>>;

export async function appendTrajectoryEvent(
  filePath: string | undefined,
  event: BenchmarkTrajectoryEventInput,
): Promise<void> {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const normalized: BenchmarkTrajectoryEvent = {
    eventId: event.eventId ?? randomUUID(),
    timestamp: event.timestamp ?? new Date().toISOString(),
    runtime: event.runtime,
    caseId: event.caseId,
    trial: event.trial,
    actor: event.actor,
    event: event.event,
  };
  await appendFile(filePath, `${JSON.stringify(normalized)}\n`, 'utf8');
}

export async function readTrajectoryEvents(filePath: string): Promise<BenchmarkTrajectoryEvent[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BenchmarkTrajectoryEvent);
}

export function summarizeText(value: string | undefined, maxLength = 240): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}
