import { rename, rm, writeFile } from 'node:fs/promises';

import { createId } from '../runtime/helpers.js';

const RETRIABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function isRetriableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRIABLE_FS_CODES.has(code);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WriteJsonAtomicOptions {
  /** Total attempts including the first try. Default 8. */
  maxAttempts?: number;
  /** Base backoff in ms; multiplied by attempt index. Default 5. */
  retryDelayMs?: number;
}

/**
 * Atomically persist JSON to disk. Retries transient Windows lock errors
 * (EPERM/EBUSY/EACCES) that surface when parent + background sessions write
 * concurrently during subagent runs.
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 8;
  const retryDelayMs = options.retryDelayMs ?? 5;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const tempPath = `${filePath}.${createId()}.tmp`;
    try {
      await writeFile(tempPath, payload, 'utf8');
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      await rm(tempPath, { force: true }).catch(() => undefined);
      const canRetry = attempt < maxAttempts - 1 && isRetriableFsError(error);
      if (!canRetry) {
        throw error;
      }
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}
