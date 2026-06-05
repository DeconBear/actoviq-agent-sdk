import { readFileSync } from 'node:fs';

export function loadRuntimeConfig(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return {
    modelProvider: raw.provider ?? 'unknown',
    timeoutMs: raw.timeoutMs ?? 3000,
    retryBudget: raw.retries ?? 0
  };
}
